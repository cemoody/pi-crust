import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

export default async function activate(prc) {
  /**
   * In-memory registry of template packs discovered from
   * `presentations.templateDirs` in the PRC settings. Per-activation so each
   * extension host has its own isolated registry (tests rely on this).
   *
   * { [packId]: { dir, manifest, renderer? } }
   */
  const packs = new Map();
  const configDirOverride = typeof prc?.configDir === 'string' && prc.configDir
    ? prc.configDir
    : null;

  // Initial scan from settings (await so callers can rely on packs being
  // available immediately after activate() resolves).
  await rescanTemplatePacks().catch(() => undefined);

  // Watch each configured dir for pack.json / render.mjs changes and rescan.
  const watchers = [];
  const settingsWatch = await startSettingsWatcher();
  if (settingsWatch) watchers.push(settingsWatch);
  for (const pack of packs.values()) {
    const w = await startPackWatcher(pack.dir);
    if (w) watchers.push(w);
  }

  // ------------------------------------------------------------------
  // Existing per-session presentation route (artifact-style download).
  // ------------------------------------------------------------------
  prc.server.api.get('/api/sessions/:sessionId/presentations/:file', async (request) => {
    const { sessionId, file } = request.params;
    if (!isSafeFileSegment(file)) return { status: 400, body: { error: 'invalid presentation filename' } };
    let session;
    try {
      session = await prc.sessions.get?.(registrySessionId(sessionId));
    } catch (error) {
      return { status: 404, body: { error: error instanceof Error ? error.message : 'unknown session' } };
    }
    if (!session || typeof session !== 'object' || typeof session.cwd !== 'string' || !session.cwd) {
      return { status: 500, body: { error: 'session has no cwd' } };
    }

    const presentationsDir = path.resolve(session.cwd, '.pi/presentations', sessionId);
    const filePath = path.resolve(presentationsDir, file);
    if (filePath !== path.join(presentationsDir, file)) return { status: 400, body: { error: 'path escape rejected' } };

    let stat;
    try { stat = await fs.stat(filePath); } catch { return { status: 404, body: { error: 'presentation not found' } }; }
    if (!stat.isFile()) return { status: 404, body: { error: 'not a file' } };
    const body = await fs.readFile(filePath);
    const ext = path.extname(file).toLowerCase();
    return {
      status: 200,
      headers: {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'private, max-age=300',
      },
      body,
    };
  });

  // ------------------------------------------------------------------
  // Template-pack routes (read-only; safe to expose).
  // ------------------------------------------------------------------
  prc.server.api.get('/api/presentations/templates', async () => {
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: {
        packs: [...packs.values()].map((p) => ({
          id: p.manifest.id,
          name: p.manifest.name,
          version: p.manifest.version,
          dir: p.dir,
          layouts: p.manifest.layouts ?? [],
        })),
      },
    };
  });

  prc.server.api.post('/api/presentations/templates/reload', async () => {
    const result = await rescanTemplatePacks();
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: result,
    };
  });

  prc.server.api.get('/api/presentations/templates/:packId/preview/:layout', async (request) => {
    const { packId, layout } = request.params ?? {};
    const pack = packs.get(packId);
    if (!pack) return { status: 404, body: { error: `Unknown template pack: ${packId}` } };
    try {
      const renderer = await loadRenderer(pack);
      const html = await renderer.render(layout, {});
      return {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: html,
      };
    } catch (error) {
      return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
    }
  });

  prc.server.api.post('/api/presentations/templates/:packId/render/:layout', async (request) => {
    const { packId, layout } = request.params ?? {};
    const pack = packs.get(packId);
    if (!pack) return { status: 404, body: { error: `Unknown template pack: ${packId}` } };
    let body;
    try { body = await request.json(); } catch { body = {}; }
    const slots = (body && typeof body === 'object' && body.slots && typeof body.slots === 'object')
      ? body.slots : {};
    try {
      const renderer = await loadRenderer(pack);
      const html = await renderer.render(layout, slots);
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: { packId, layout, html },
      };
    } catch (error) {
      return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
    }
  });

  // ------------------------------------------------------------------
  // Template-pack scanning + loading
  // ------------------------------------------------------------------

  async function rescanTemplatePacks() {
    const dirs = await readTemplateDirsFromSettings();
    const seen = new Map();
    for (const rawDir of dirs) {
      const dir = expandHome(rawDir);
      try {
        const manifest = await readManifest(dir);
        if (!manifest?.id) continue;
        if (seen.has(manifest.id)) continue;
        seen.set(manifest.id, { dir, manifest });
      } catch {
        // Skip invalid/missing dirs silently; report via the response.
      }
    }
    packs.clear();
    for (const [id, entry] of seen.entries()) packs.set(id, entry);
    return {
      scanned: dirs,
      loaded: [...packs.values()].map((p) => ({
        id: p.manifest.id, dir: p.dir, layouts: p.manifest.layouts?.length ?? 0,
      })),
    };
  }

  async function startSettingsWatcher() {
    const configDir = configDirOverride
      ?? process.env.PI_REMOTE_CONFIG_DIR
      ?? path.join(os.homedir(), '.pi-remote-control');
    const settingsPath = path.join(configDir, 'settings.json');
    try {
      const watcher = (await import('node:fs')).watch(settingsPath, { persistent: false }, debounce(() => { void rescanTemplatePacks().catch(() => undefined); }, 200));
      return { close: () => watcher.close() };
    } catch { return null; }
  }

  async function startPackWatcher(dir) {
    try {
      const watcher = (await import('node:fs')).watch(dir, { persistent: false, recursive: false }, debounce(() => { void rescanTemplatePacks().catch(() => undefined); }, 200));
      return { close: () => watcher.close() };
    } catch { return null; }
  }

  async function readTemplateDirsFromSettings() {
    const configDir = configDirOverride
      ?? process.env.PI_REMOTE_CONFIG_DIR
      ?? path.join(os.homedir(), '.pi-remote-control');
    const settingsPath = path.join(configDir, 'settings.json');
    try {
      const raw = await fs.readFile(settingsPath, 'utf8');
      const json = JSON.parse(raw);
      const list = json?.presentations?.templateDirs;
      if (Array.isArray(list)) return list.filter((entry) => typeof entry === 'string' && entry.length > 0);
    } catch {
      // No settings or unreadable -> no template dirs.
    }
    return [];
  }
  // Return a dispose() so the extension host can tear down watchers on reload.
  return {
    dispose: () => {
      for (const w of watchers) { try { w.close(); } catch { /* ignore */ } }
      watchers.length = 0;
    },
  };
} // end activate()

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// --------------------------------------------------------------------
// Module-scope helpers (pure / stateless)
// --------------------------------------------------------------------

async function readManifest(dir) {
  const manifestPath = path.join(dir, 'pack.json');
  const raw = await fs.readFile(manifestPath, 'utf8');
  return JSON.parse(raw);
}

async function loadRenderer(pack) {
  if (pack.renderer) return pack.renderer;
  const entry = pack.manifest.entry ?? './render.mjs';
  const entryPath = path.resolve(pack.dir, entry);
  // Cache-bust by appending the file's mtime so /reload picks up changes.
  let mtime;
  try { mtime = (await fs.stat(entryPath)).mtimeMs; } catch { mtime = Date.now(); }
  const url = `${pathToFileURL(entryPath).href}?ts=${mtime}`;
  const mod = await import(url);
  const render = typeof mod.renderSlide === 'function'
    ? mod.renderSlide
    : (typeof mod.default === 'function' ? mod.default : null);
  if (!render) throw new Error(`Template pack ${pack.manifest.id} has no renderSlide() export at ${entryPath}`);
  pack.renderer = { render };
  return pack.renderer;
}

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function registrySessionId(sessionId) {
  const underscoreIdx = sessionId.lastIndexOf('_');
  return underscoreIdx >= 0 ? sessionId.slice(underscoreIdx + 1) : sessionId;
}

function isSafeFileSegment(file) {
  return typeof file === 'string' && file !== '' && file !== '.' && file !== '..' && !file.includes('/') && !file.includes('\\') && !file.includes('\0');
}
