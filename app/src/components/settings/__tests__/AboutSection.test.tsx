// @vitest-environment jsdom
/**
 * Tests for AboutSection — the AGPL §5 license / credits surface.
 *
 * Covers the contract the status-bar AGPL link relies on:
 *  - The AGPL-3.0 marker and app/version are visible.
 *  - All six third-party attributions render in a real <table>.
 *  - "View license" and "View source" are real buttons (Tauri shell.open
 *    triggers, not WebView <a href> navigations).
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const openSpy = vi.fn(async (_url: string) => {});

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: (url: string) => openSpy(url),
}));

import AboutSection from "../AboutSection";

beforeEach(() => {
  openSpy.mockReset();
  cleanup();
});

describe("AboutSection", () => {
  test("renders the AGPL-3.0 marker and app version", () => {
    render(<AboutSection />);

    expect(screen.getByText("MinerU True Copy v0.1.0")).toBeTruthy();
    // "AGPL-3.0" appears twice: once as the app's own license, and once in
    // the MinerU attribution row.
    expect(screen.getAllByText("AGPL-3.0").length).toBeGreaterThanOrEqual(1);
  });

  test("renders all 6 third-party attributions in order", () => {
    render(<AboutSection />);

    const expected = [
      "MinerU",
      "IndicTrans2",
      "PaddleOCR",
      "font_classifier",
      "Noto Sans",
      "Geist",
    ];

    for (const name of expected) {
      expect(
        screen.getByRole("button", { name: new RegExp(`^${escapeRegex(name)}$`) })
      ).toBeTruthy();
    }

    // Plus a header row → 7 total.
    const rows = screen.getAllByRole("row");
    expect(rows.length).toBe(expected.length + 1);

    // Verify ordering by reading the first cell of each body row.
    const tbody = screen.getByRole("table").querySelector("tbody");
    expect(tbody).toBeTruthy();
    const bodyRows = within(tbody as HTMLElement).getAllByRole("row");
    bodyRows.forEach((row, i) => {
      expect(row.textContent).toContain(expected[i]);
    });
  });

  test("license and source links are real buttons", () => {
    render(<AboutSection />);

    expect(
      screen.getByRole("button", { name: /view license/i })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /view source/i })
    ).toBeTruthy();
  });

  test("clicking View source calls shell.open with the repo URL", async () => {
    const user = userEvent.setup();
    render(<AboutSection />);

    await user.click(screen.getByRole("button", { name: /view source/i }));

    expect(openSpy).toHaveBeenCalledWith(
      "https://github.com/adoistic/mineru-true-copy"
    );
  });

  test("attribution table is semantically a <table>", () => {
    render(<AboutSection />);

    expect(screen.getByRole("table")).toBeTruthy();
  });
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
