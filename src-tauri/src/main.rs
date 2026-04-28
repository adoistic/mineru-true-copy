#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpListener;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_shell::ShellExt;

/// Find a free TCP port by binding to port 0 and reading the assigned port.
fn find_free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("failed to bind ephemeral port")
        .local_addr()
        .expect("failed to get local addr")
        .port()
}

/// Emit a splash screen state update.
fn splash_emit(app: &tauri::AppHandle, state: &str, detail: Option<&str>) {
    let payload = serde_json::json!({ "state": state, "detail": detail });
    let _ = app.emit("splash-update", payload);
}

/// Poll a health endpoint until it returns HTTP 200 or timeout is reached.
async fn wait_for_health(url: &str, timeout: Duration) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let start = std::time::Instant::now();
    loop {
        if start.elapsed() > timeout {
            return Err(format!("Timed out waiting for {url} after {timeout:?}"));
        }
        match client.get(url).send().await {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            _ => {}
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();

            // In dev mode (no externalBin configured), skip sidecar boot
            // and connect directly to manually-started services.
            let is_dev = cfg!(debug_assertions);

            if is_dev {
                // Dev mode: Next.js on :3000 and MinerU on :8765 are started manually
                tauri::async_runtime::spawn(async move {
                    splash_emit(&handle, "starting", Some("Dev mode — connecting to localhost:3000"));

                    // Wait for Next.js to be ready
                    if let Err(e) = wait_for_health("http://localhost:3000/api/health", Duration::from_secs(10)).await {
                        eprintln!("[dev] Next.js not ready: {e}. Navigating anyway...");
                    }

                    splash_emit(&handle, "ready", None);
                    tokio::time::sleep(Duration::from_millis(200)).await;

                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.navigate("http://localhost:3000".parse().unwrap());
                    }
                });
            } else {
                // Production mode: spawn sidecars

                // Find two free ports for sidecars
                let mineru_port = find_free_port();
                let node_port = find_free_port();

                // Resolve bundled models path
                let resource_path = handle
                    .path()
                    .resource_dir()
                    .expect("failed to resolve resource dir");
                let models_path = resource_path.join("models");

                // Write magic-pdf.json pointing to bundled models
                let magic_pdf_config = serde_json::json!({
                    "models-dir": models_path.to_string_lossy(),
                    "device-mode": "mps",
                    "table-config": {
                        "model": "rapid_table",
                        "enable": true,
                        "max_time": 400
                    },
                    "layout-config": {
                        "model": "doclayout_yolo"
                    },
                    "formula-config": {
                        "mfd_model": "yolo_v8_mfd",
                        "mfr_model": "unimernet_small",
                        "enable": true
                    }
                });

                if let Some(home) = dirs::home_dir() {
                    let config_path = home.join("magic-pdf.json");
                    let _ = std::fs::write(
                        &config_path,
                        serde_json::to_string_pretty(&magic_pdf_config).unwrap(),
                    );
                }

                // Spawn sidecar boot sequence in background
                tauri::async_runtime::spawn(async move {
                    splash_emit(&handle, "starting", None);

                    // --- Spawn MinerU sidecar ---
                    splash_emit(&handle, "models", None);

                    let mineru_sidecar = handle
                        .shell()
                        .sidecar("mineru-server")
                        .expect("failed to create mineru-server sidecar")
                        .args([
                            "--port",
                            &mineru_port.to_string(),
                            "--models-dir",
                            &models_path.to_string_lossy(),
                        ])
                        .spawn();

                    let _mineru_child = match mineru_sidecar {
                        Ok((rx, child)) => {
                            // Log sidecar output for debugging
                            tauri::async_runtime::spawn(async move {
                                use tauri_plugin_shell::process::CommandEvent;
                                let mut rx = rx;
                                while let Some(event) = rx.recv().await {
                                    match event {
                                        CommandEvent::Stdout(line) => {
                                            eprintln!("[mineru] {}", String::from_utf8_lossy(&line));
                                        }
                                        CommandEvent::Stderr(line) => {
                                            eprintln!("[mineru:err] {}", String::from_utf8_lossy(&line));
                                        }
                                        _ => {}
                                    }
                                }
                            });
                            child
                        }
                        Err(e) => {
                            splash_emit(
                                &handle,
                                "error",
                                Some(&format!("Failed to start processing engine: {e}")),
                            );
                            return;
                        }
                    };

                    // Wait for MinerU health (up to 90s for model warm-up)
                    let mineru_health = format!("http://127.0.0.1:{mineru_port}/health");
                    if let Err(e) = wait_for_health(&mineru_health, Duration::from_secs(90)).await {
                        splash_emit(
                            &handle,
                            "error",
                            Some(&format!("Processing engine failed to start: {e}")),
                        );
                        return;
                    }

                    // --- Spawn Node.js sidecar ---
                    splash_emit(&handle, "server", None);

                    let mineru_url = format!("http://127.0.0.1:{mineru_port}");
                    let node_sidecar = handle
                        .shell()
                        .sidecar("node-server")
                        .expect("failed to create node-server sidecar")
                        .args([&node_port.to_string(), &mineru_url])
                        .spawn();

                    let _node_child = match node_sidecar {
                        Ok((rx, child)) => {
                            tauri::async_runtime::spawn(async move {
                                use tauri_plugin_shell::process::CommandEvent;
                                let mut rx = rx;
                                while let Some(event) = rx.recv().await {
                                    match event {
                                        CommandEvent::Stdout(line) => {
                                            eprintln!("[node] {}", String::from_utf8_lossy(&line));
                                        }
                                        CommandEvent::Stderr(line) => {
                                            eprintln!("[node:err] {}", String::from_utf8_lossy(&line));
                                        }
                                        _ => {}
                                    }
                                }
                            });
                            child
                        }
                        Err(e) => {
                            splash_emit(
                                &handle,
                                "error",
                                Some(&format!("Failed to start application server: {e}")),
                            );
                            return;
                        }
                    };

                    // Wait for Node.js health (up to 30s)
                    let node_health = format!("http://127.0.0.1:{node_port}/api/health");
                    if let Err(e) = wait_for_health(&node_health, Duration::from_secs(30)).await {
                        splash_emit(
                            &handle,
                            "error",
                            Some(&format!("Application server failed to start: {e}")),
                        );
                        return;
                    }

                    // --- Both ready: navigate to app ---
                    splash_emit(&handle, "ready", None);

                    // Brief pause so user sees "Ready" state
                    tokio::time::sleep(Duration::from_millis(400)).await;

                    let app_url = format!("http://127.0.0.1:{node_port}");
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.navigate(app_url.parse().unwrap());
                    }
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Tauri automatically kills sidecar child processes on app exit
                // when they are spawned via the shell plugin's sidecar API.
                // The plugin tracks child PIDs and sends SIGTERM on close.
                eprintln!("[app] Window close requested, sidecars will be terminated");
                let _ = window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
