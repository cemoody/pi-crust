import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

test("npx-style fresh install can add artifact image rendering to an existing session", async ({ page }) => {
  test.setTimeout(180_000);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prc-npx-artifact-e2e-"));
  let server: ChildProcess | undefined;
  try {
    const tarball = await npmPack(root);
    const home = path.join(root, "home");
    const configDir = path.join(home, ".pi-crust");
    const projectRoot = path.join(root, "project");
    const sessionRoot = path.join(root, "sessions");
    const extensionDir = path.join(root, "external-artifacts");
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(sessionRoot, { recursive: true });
    await copyArtifactsExtension(extensionDir);
    await fs.writeFile(path.join(configDir, "settings.json"), `${JSON.stringify({ disabledExtensions: ["core.artifacts", "core.branching", "core.schedule"] }, null, 2)}\n`, "utf8");
    await writeArtifactSession({ projectRoot, sessionRoot });

    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    server = spawn("npm", ["exec", "--yes", `--package=${tarball}`, "--", "pi-crust"], {
      cwd: projectRoot,
      detached: true,
      env: {
        ...process.env,
        HOME: home,
        PI_CRUST_CONFIG_DIR: configDir,
        PI_CRUST_PROJECT_ROOT: projectRoot,
        PI_CRUST_SESSION_ROOT: sessionRoot,
        PI_CRUST_API_PORT: String(port),
        PI_CRUST_API_HOST: "127.0.0.1",
        PI_CRUST_USE_MOCK: "1",
        PI_CRUST_OPEN: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const logs: string[] = [];
    server.stdout?.on("data", (chunk) => logs.push(String(chunk)));
    server.stderr?.on("data", (chunk) => logs.push(String(chunk)));
    await waitForHttp(`${url}/api/health`, logs);

    await page.goto(url);
    await page.getByRole("link", { name: /^Image artifact session\b/ }).click();
    await expect(page.getByText("Session image artifact")).toBeVisible();
    await expect(page.locator('[data-testid="artifact-image"]')).toHaveJSProperty("naturalWidth", 0);

    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await page.getByLabel("Extension package source").fill(extensionDir);
    await page.getByRole("button", { name: "Install" }).click();
    await expect(page.getByText("Extension installed and reloaded.")).toBeVisible();
    await expect(page.getByText("dev.artifacts")).toBeVisible();

    await page.getByRole("link", { name: /^Image artifact session\b/ }).click();
    await expect(page.locator('[data-testid="artifact-image"]')).toHaveJSProperty("naturalWidth", 960);
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

async function copyArtifactsExtension(extensionDir: string): Promise<void> {
  await fs.cp(path.join(repoRoot, "extensions", "artifacts"), extensionDir, { recursive: true });
  const pkgPath = path.join(extensionDir, "package.json");
  const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  pkg.name = "dev.artifacts";
  await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

async function writeArtifactSession(input: { readonly projectRoot: string; readonly sessionRoot: string }): Promise<void> {
  const sessionId = crypto.randomUUID();
  const timestamp = Date.now();
  const sessionFile = path.join(input.sessionRoot, `${timestamp}_${sessionId}.mock-session.json`);
  const artifactFile = "session-image-artifact.svg";
  const artifactUrl = `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${artifactFile}`;
  const artifactDir = path.join(input.projectRoot, ".pi", "artifacts", sessionId);
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, artifactFile), artifactSvg(), "utf8");
  await fs.writeFile(sessionFile, `${JSON.stringify({
    id: sessionId,
    cwd: input.projectRoot,
    sessionFile,
    sessionName: "Image artifact session",
    lastActivity: timestamp + 2,
    messages: [
      { role: "user", content: "Show me the artifact image.", timestamp },
      {
        role: "custom",
        content: "Image artifact generated by Pi.",
        timestamp: timestamp + 1,
        customType: "artifact",
        details: {
          version: 1,
          artifactGroupId: "image-demo",
          caption: "Session image artifact",
          artifacts: [
            { mime: "image/svg+xml", src: { kind: "url", url: artifactUrl }, alt: "pi-crust artifact demo image" },
            { mime: "text/plain", text: "Session image artifact" },
          ],
        },
      },
    ],
  }, null, 2)}\n`, "utf8");
}

function artifactSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="480" viewBox="0 0 960 480">
  <rect width="960" height="480" rx="32" fill="#2563eb"/>
  <rect x="92" y="86" width="776" height="308" rx="28" fill="#ffffff" opacity="0.96"/>
  <circle cx="174" cy="172" r="46" fill="#22c55e"/>
  <path d="M151 173l15 15 34-39" fill="none" stroke="white" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="244" y="166" font-family="Inter, system-ui, sans-serif" font-size="44" font-weight="700" fill="#111827">Image artifact</text>
  <text x="244" y="218" font-family="Inter, system-ui, sans-serif" font-size="24" fill="#4b5563">Rendered inside the active pi-crust session</text>
  <text x="244" y="292" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="19" fill="#1d4ed8">served by dev.artifacts</text>
</svg>`;
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
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} failed with ${code}\n${output}`)));
  });
}

async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("no address")));
    });
  });
}
