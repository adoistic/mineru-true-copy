# Contributing to MinerU True Copy

## 1. Development setup

### Prerequisites

**macOS (Apple Silicon recommended)**

```bash
# Xcode command-line tools (required by Tauri)
xcode-select --install

# Homebrew system deps for Tauri
brew install pkg-config openssl cmake

# Rust (stable)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup default stable

# Node.js v22 LTS (the bundled sidecar targets 22.16.0)
brew install node@22
```

The Cargo.toml uses `edition = "2021"` and Tauri v2 crates. Rust stable as of 2025 is sufficient; no nightly required.

**Node version note:** `app/package.json` does not pin an `engines` field. Development works on Node 22+. The production sidecar bundles Node 22.16.0 (see `scripts/build-node-sidecar.sh`).

### Python sidecar (`mineru-venv/`)

The `mineru-venv/` directory is a Python 3.12 virtual environment. It is not committed. Recreate it:

```bash
# From repo root
python3.12 -m venv mineru-venv
```

There is no `requirements.txt` at v0.1. The MinerU dependency list lives in the PyInstaller spec at `scripts/bundle-mineru.spec` and the imports at the top of `mineru_server.py`. Documenting a clean dependency manifest is an open contributor task — see `docs/HELP-WANTED.md`.

`translation_server.py` expects a separate `test-venv/` with IndicTrans2 deps (see the usage comment at the top of that file). The `scripts/build-mineru.sh` PyInstaller bundle also runs from `test-venv/`, not `mineru-venv/`.

### Node dependencies

```bash
cd app
npm install
```

---

## 2. Local dev workflow

Three services plus the desktop window. Open four terminals from the repo root (Terminal 4 is optional and only needed for translation work).

**Terminal 1 — Next.js dev server**
```bash
cd app
npm run dev
# Serves on http://localhost:51821 (matches tauri.conf.json devUrl)
```

**Terminal 2 — Tauri dev** (launches the desktop window)
```bash
# From repo root — Terminal 1 must already be running (Tauri loads from devUrl)
npx @tauri-apps/cli dev
```
The Tauri CLI is not in `app/package.json` devDependencies and is not installed globally by default. Use `npx` as shown, or install once with `cargo install tauri-cli` if you prefer `cargo tauri dev`.

**Terminal 3 — MinerU server**
```bash
./mineru-venv/bin/python mineru_server.py
# Default port 8765; pass --port to override
```

**Terminal 4 — Translation server** (optional, only needed for translation features)
```bash
./test-venv/bin/python translation_server.py
# Default port 51823
```

---

## 3. Test commands

Run the suites relevant to your change before opening a PR. A frontend-only change does not need the Python suite if the venv isn't set up, but anything touching `lib/` or the sidecars must run pytest.

### Next.js lint (run from `app/`)
```bash
cd app
npm run lint
```
`lint` is defined in `app/package.json` and runs `eslint`.

### Vitest unit tests (run from `app/`)
```bash
cd app
npx vitest run
```
`vitest` is a devDependency. There is no `test` script in `app/package.json`; use `npx vitest run` directly (or `npx vitest` for watch mode).

### Python tests (run from repo root)
```bash
./mineru-venv/bin/pytest lib/tests/
```
Test files live in `lib/tests/`. Adjust the venv path if your environment differs.

### Rust type/borrow check (run from `src-tauri/`)
```bash
cd src-tauri
cargo check
```

---

## 4. PR submission process

1. Branch from `main`:
   ```bash
   git checkout main && git pull
   git checkout -b type/short-description
   ```
2. Follow `.github/PULL_REQUEST_TEMPLATE.md` when opening your PR.
3. Link the relevant issue in the PR body (`Closes #N`).
4. If your change adds a new third-party library, update `NOTICE` with the package name, license, and copyright holder. See the existing entries in `NOTICE` for the format — the AGPL copyleft rationale is documented there.
5. All four test commands in section 3 must be green.

---

## 5. CI workflow notes

`ci.yml` (`.github/workflows/ci.yml`) uses `tauri-apps/tauri-action`. Two jobs run on every PR (`test` on macos-latest + `strip-clean` on ubuntu-latest); a third (`release`) runs on `v*` tag pushes and produces a `.dmg` in a draft GitHub Release.

The `strip-clean` job blocks any PR that reintroduces post-AGPL-relaunch forbidden symbols (`firebase`, `deductCredit`, `activationKey`, `ActivationScreen`). If you have a legitimate need to add one of these strings, raise it in the PR.

---

## 6. Code style and commit conventions

This repo uses [Conventional Commits](https://www.conventionalcommits.org/) with lowercase subjects:

```
type(scope): subject in imperative mood, lowercase
```

**Types in use:** `feat`, `fix`, `chore`, `docs`, `test`, `refactor`

**Scopes in use:** `settings`, `server`, `tauri`, `ocr`, `translation`, `runner` — use the component name or omit scope for cross-cutting changes.

**Em-dash in subjects:** the log uses ` — ` (space + em-dash + space) as a secondary separator when a subject has two logical parts, e.g.:
```
chore: pre-v0.1 cleanup — README checkboxes, dead deps, internal docs
```

**Body and footer:** not required for small changes. For breaking changes add `BREAKING CHANGE:` in the footer.

**Examples from this repo:**
```
feat(settings): add ApiKeysPanel for OpenRouter key management
fix(tauri): grant store:default capability + document key-state pub/sub
test(runner): smoke test confirming pipeline runs clean post-strip
docs: add CONTRIBUTING.md
```

Squash fixup commits before merging. One logical change per commit.
