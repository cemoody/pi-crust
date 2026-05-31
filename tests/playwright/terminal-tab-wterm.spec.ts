/**
 * Headline E2E: open the Terminal from the sidebar → wterm reveals a real bash
 * shell → a typed command creates a file on disk → assert the file exists.
 * Spec: docs/terminal-wterm-tdd-plan.md contract items 26–30.
 *
 * Runs against the real server (PI_CRUST_USE_MOCK=1 for the LLM adapter; the
 * PTY backend is a REAL node-pty bash). The seeded session's cwd is the repo
 * root, which the server path policy allows and this test can read from disk.
 */
import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PROBE_REL = path.join(".tmp", `wterm-probe-${RUN_ID}.txt`);
const SENTINEL = `pi-crust-e2e-${RUN_ID}`;

async function openTerminal(page: import("@playwright/test").Page) {
  await page.goto("/");
  // Pick the seeded session so the terminal opens in its (repo-root) cwd, then
  // open the Terminal from the sidebar (above Settings) — not an in-session tab.
  await page.getByRole("link", { name: /^Seeded session\b/ }).click();
  // Session rows show a cwd path that contains "terminal", so target the
  // sidebar menu item by its stable test id rather than accessible name.
  await page.getByTestId("sidebar-terminal").click();
}

test("Terminal (sidebar) reveals wterm and a typed bash command creates a real file", async ({ page }) => {
  test.setTimeout(60_000);
  await openTerminal(page);

  // 26. The wterm host mounts and the shell prompt renders. The prompt glyph
  // varies by the user's shell theme ($, # or oh-my-zsh's ➜), so match any.
  const host = page.getByTestId("wterm-root");
  await expect(host).toBeVisible();
  await expect(host).toContainText(/[$#➜]/, { timeout: 15_000 });

  // 27 + 28. Type a command that writes a sentinel file, then ⏎.
  // wterm renders to the DOM, so the typed echo is selectable text.
  await host.click();
  const cwd = process.env.PI_CRUST_PROJECT_ROOT ?? process.cwd();
  const probeAbs = path.join(cwd, PROBE_REL);
  await fs.mkdir(path.dirname(probeAbs), { recursive: true }).catch(() => {});

  // 28: the terminal renders to the DOM (not a canvas), so typed input is real,
  // selectable text. Prove it with a short marker that won't line-wrap, then run
  // the (longer) file-creating command whose authoritative proof is the file.
  await page.keyboard.type("echo wterm-dom-echo");
  await expect(host).toContainText("wterm-dom-echo", { timeout: 10_000 });
  await page.keyboard.press("Enter");

  await page.keyboard.type(`mkdir -p .tmp && printf '%s' "${SENTINEL}" > "${PROBE_REL}"`);
  await page.keyboard.press("Enter");

  // 27: the bash side effect is real — poll the file on disk.
  await expect.poll(async () => {
    try { return await fs.readFile(probeAbs, "utf8"); } catch { return null; }
  }, { timeout: 15_000, message: "probe file should be created by the in-terminal bash" }).toBe(SENTINEL);

  await fs.rm(probeAbs, { force: true });
});

test("Terminal (sidebar) mounts without console or page errors", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const url = m.location()?.url ?? "";
    // Known-benign: the dev proxy 502s the telemetry beacon in this harness.
    if (/client-event/.test(url)) return;
    consoleErrors.push(`${m.text()} @ ${url}`);
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await openTerminal(page);
  await expect(page.getByTestId("wterm-root")).toBeVisible();
  await expect(page.getByTestId("wterm-root")).toContainText(/[$#➜]/, { timeout: 15_000 });

  expect(pageErrors, "no uncaught exceptions").toEqual([]);
  expect(consoleErrors, "no console errors").toEqual([]);
});
