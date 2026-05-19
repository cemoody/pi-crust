import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

test("npx-style fresh install can install, render, and hot reload an extension UI", async ({ page }) => {
  test.setTimeout(180_000);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prc-npx-e2e-"));
  let server: ChildProcess | undefined;
  try {
    const tarball = await npmPack(root);
    const home = path.join(root, "home");
    const configDir = path.join(home, ".pi-remote-control");
    const projectRoot = path.join(root, "project");
    const sessionRoot = path.join(root, "sessions");
    const extensionDir = path.join(root, "external-schedule");
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(sessionRoot, { recursive: true });
    await writeScheduleExtension(extensionDir, "Blank schedule extension UI");
    await fs.writeFile(path.join(configDir, "settings.json"), `${JSON.stringify({ disabledExtensions: ["core.schedule"] }, null, 2)}\n`, "utf8");

    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    server = spawn("npm", ["exec", "--yes", `--package=${tarball}`, "--", "pi-remote-control"], {
      cwd: projectRoot,
      detached: true,
      env: {
        ...process.env,
        HOME: home,
        PI_REMOTE_CONFIG_DIR: configDir,
        PI_REMOTE_PROJECT_ROOT: projectRoot,
        PI_REMOTE_SESSION_ROOT: sessionRoot,
        PI_REMOTE_API_PORT: String(port),
        PI_REMOTE_API_HOST: "127.0.0.1",
        PI_REMOTE_USE_MOCK: "1",
        PI_REMOTE_OPEN: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const logs: string[] = [];
    server.stdout?.on("data", (chunk) => logs.push(String(chunk)));
    server.stderr?.on("data", (chunk) => logs.push(String(chunk)));
    await waitForHttp(`${url}/api/health`, logs);

    await page.goto(url);
    await expect(page.getByRole("heading", { name: "pi remote" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Schedule" })).toHaveCount(0);

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await page.getByLabel("Extension package source").fill(extensionDir);
    await page.getByRole("button", { name: "Install" }).click();
    await expect(page.getByRole("button", { name: "Schedule" })).toBeVisible();

    await page.getByRole("button", { name: "Schedule" }).click();
    await expect(page.getByText("Blank schedule extension UI")).toBeVisible();

    await writeScheduleExtension(extensionDir, "Hot reloaded schedule extension UI");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Reload" }).click();
    await page.getByRole("button", { name: "Schedule" }).click();
    await expect(page.getByText("Hot reloaded schedule extension UI")).toBeVisible();
  } finally {
    if (server?.pid) {
      try { process.kill(-server.pid, "SIGTERM"); } catch { server.kill("SIGTERM"); }
      await new Promise((resolve) => setTimeout(resolve, 500));
      try { process.kill(-server.pid, "SIGKILL"); } catch { /* already exited */ }
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function npmPack(root: string): Promise<string> {
  const packDir = path.join(root, "pack");
  await fs.mkdir(packDir, { recursive: true });
  await run("npm", ["run", "build"], { cwd: repoRoot });
  await run("npm", ["pack", "--pack-destination", packDir, "--silent"], { cwd: repoRoot });
  const files = await fs.readdir(packDir);
  const packed = files.find((file) => file.endsWith(".tgz"));
  if (!packed) throw new Error("npm pack did not produce a tarball");
  return path.join(packDir, packed);
}

async function writeScheduleExtension(extensionDir: string, text: string): Promise<void> {
  await fs.mkdir(extensionDir, { recursive: true });
  await fs.writeFile(path.join(extensionDir, "package.json"), `${JSON.stringify({
    name: "third.schedule",
    version: "0.0.0-test",
    piRemoteControl: { extension: "./server.mjs", web: "./web.mjs" },
  }, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(extensionDir, "server.mjs"), "export default function activate(prc) { prc.activity.registerView({ id: 'third.schedule.activity', title: 'Schedule' }); }\n", "utf8");
  await fs.writeFile(path.join(extensionDir, "web.mjs"), `export function renderActivity(props) { return props.React.createElement('section', null, props.React.createElement('h2', null, 'Schedule'), props.React.createElement('p', null, ${JSON.stringify(text)})); }\n`, "utf8");
}

async function waitForHttp(url: string, logs: readonly string[]): Promise<void> {
  const deadline = Date.now() + 120_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}\n${logs.join("")}`);
}

async function run(command: string, args: readonly string[], options: { cwd: string }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, stdio: "pipe" });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} failed with ${code}\n${output}`)));
  });
}

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No TCP address"));
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
