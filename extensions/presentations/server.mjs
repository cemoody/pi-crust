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
   * `presentations.templateDirs` in the pi-crust settings. Per-activation so each
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

  // --------------------------------------------------------------------
  // Persisted deck edits: GET / PUT / PATCH `<deckId>.deck.json`.
  // Files live under `<session.cwd>/.pi/presentations/<sessionId>/`,
  // namespaced by the `.deck.json` suffix so they don't collide with
  // image assets served by the route above.
  // --------------------------------------------------------------------
  prc.server.api.get('/api/sessions/:sessionId/presentations/:deckId/deck.json', async (request) => {
    const ctx = await resolveDeckContext(request);
    if (ctx.error) return ctx.error;
    try {
      const raw = await fs.readFile(ctx.filePath, 'utf8');
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.parse(raw),
      };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { status: 404, body: { error: 'no persisted deck' } };
      return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  });

  prc.server.api.put('/api/sessions/:sessionId/presentations/:deckId/deck.json', async (request) => {
    const ctx = await resolveDeckContext(request);
    if (ctx.error) return ctx.error;
    let body;
    try { body = await request.json(); } catch { return { status: 400, body: { error: 'invalid JSON body' } }; }
    const deck = body && typeof body === 'object' ? body.deck : undefined;
    const validation = validateDeck(deck);
    if (!validation.ok) return { status: 400, body: { error: validation.errors.join('; ') } };
    try {
      const envelope = await withDeckLock(ctx.lockKey, async () => {
        const env = { version: 1, deckId: ctx.deckId, updatedAt: Date.now(), deck };
        await writeDeckFileAtomic(ctx.dir, ctx.filePath, env);
        return env;
      });
      return { status: 200, body: envelope };
    } catch (err) {
      return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  });

  prc.server.api.patch('/api/sessions/:sessionId/presentations/:deckId/deck.json', async (request) => {
    const ctx = await resolveDeckContext(request);
    if (ctx.error) return ctx.error;
    let body;
    try { body = await request.json(); } catch { return { status: 400, body: { error: 'invalid JSON body' } }; }
    if (!body || typeof body !== 'object') return { status: 400, body: { error: 'expected an object body' } };
    const ops = Array.isArray(body.ops) ? body.ops : null;
    if (!ops) return { status: 400, body: { error: 'ops must be an array' } };
    try {
      const result = await withDeckLock(ctx.lockKey, async () => {
        // Load existing envelope, or seed from `initial` when this is the
        // first edit (lazy create).
        let envelope = null;
        try {
          envelope = JSON.parse(await fs.readFile(ctx.filePath, 'utf8'));
        } catch (err) {
          if (!err || err.code !== 'ENOENT') throw err;
        }
        if (!envelope) {
          const initial = body.initial;
          const validation = validateDeck(initial);
          if (!validation.ok) {
            const err = new Error('no persisted deck and no valid `initial` supplied: ' + validation.errors.join('; '));
            err.statusCode = 404;
            throw err;
          }
          envelope = { version: 1, deckId: ctx.deckId, updatedAt: Date.now(), deck: initial };
        }
        // Apply ops with allowlist + validation.
        let next;
        try {
          next = applyDeckPatchPure(envelope.deck, ops);
        } catch (err) {
          const wrapped = new Error(err instanceof Error ? err.message : String(err));
          wrapped.statusCode = 400;
          throw wrapped;
        }
        const env = { version: 1, deckId: ctx.deckId, updatedAt: Date.now(), deck: next };
        await writeDeckFileAtomic(ctx.dir, ctx.filePath, env);
        return env;
      });
      return { status: 200, body: result };
    } catch (err) {
      const status = err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      return { status, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  });

  async function resolveDeckContext(request) {
    const { sessionId, deckId } = request.params ?? {};
    if (!isSafeFileSegment(deckId)) return { error: { status: 400, body: { error: 'invalid deckId' } } };
    let session;
    try {
      session = await prc.sessions.get?.(registrySessionId(sessionId));
    } catch (err) {
      return { error: { status: 404, body: { error: err instanceof Error ? err.message : 'unknown session' } } };
    }
    if (!session || typeof session.cwd !== 'string' || !session.cwd) {
      return { error: { status: 404, body: { error: 'session has no cwd' } } };
    }
    const dir = path.resolve(session.cwd, '.pi/presentations', sessionId);
    const fileName = `${deckId}.deck.json`;
    const filePath = path.resolve(dir, fileName);
    if (filePath !== path.join(dir, fileName)) {
      return { error: { status: 400, body: { error: 'path escape rejected' } } };
    }
    return { sessionId, deckId, dir, filePath, lockKey: `${sessionId}::${deckId}` };
  }

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
      ?? process.env.PI_CRUST_CONFIG_DIR
      ?? path.join(os.homedir(), '.pi-crust');
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
      ?? process.env.PI_CRUST_CONFIG_DIR
      ?? path.join(os.homedir(), '.pi-crust');
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

// --------------------------------------------------------------------
// Persisted deck edits — helpers (pure, module-scope)
// --------------------------------------------------------------------

const DECK_LOCKS = new Map();

async function withDeckLock(key, fn) {
  const prev = DECK_LOCKS.get(key) ?? Promise.resolve();
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  DECK_LOCKS.set(key, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (DECK_LOCKS.get(key) === prev.then(() => next)) DECK_LOCKS.delete(key);
  }
}

async function writeDeckFileAtomic(dir, filePath, envelope) {
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const data = JSON.stringify(envelope, null, 2);
  await fs.writeFile(tmp, data, 'utf8');
  try { await fs.rename(tmp, filePath); }
  catch (err) { try { await fs.unlink(tmp); } catch { /* ignore */ } throw err; }
}

// Mirror of src/presentations/schema.ts validation. Kept tiny and local so
// the .mjs extension stays import-free.
function validateDeck(value) {
  const errors = [];
  if (!value || typeof value !== 'object') return { ok: false, errors: ['deck must be an object'] };
  if (typeof value.title !== 'string' || value.title.trim() === '') errors.push('title is required');
  if (!Array.isArray(value.slides) || value.slides.length === 0) {
    errors.push('slides must be a non-empty array');
  } else {
    value.slides.forEach((slide, i) => {
      if (!slide || typeof slide !== 'object') { errors.push(`slides[${i}] must be an object`); return; }
      const hasContent = ['title','subtitle','body','quote','html'].some((k) => typeof slide[k] === 'string' && slide[k].trim() !== '')
        || (Array.isArray(slide.bullets) && slide.bullets.length > 0)
        || (Array.isArray(slide.columns) && slide.columns.length > 0)
        || (Array.isArray(slide.stats) && slide.stats.length > 0)
        || (slide.image && typeof slide.image === 'object');
      if (!hasContent) errors.push(`slides[${i}] must contain visible content`);
    });
  }
  return { ok: errors.length === 0, errors };
}

// Allowlist mirror — keep in sync with src/presentations/patch.ts
const EDITABLE_PATTERNS = [
  /^\/title$/,
  /^\/subtitle$/,
  /^\/confidential$/,
  /^\/slides\/\d+\/(title|subtitle|eyebrow|body|quote|attribution|notes)$/,
  /^\/slides\/\d+\/bullets\/\d+$/,
  /^\/slides\/\d+\/bullets\/\d+\/(text|detail)$/,
  /^\/slides\/\d+\/stats\/\d+\/(value|label)$/,
  /^\/slides\/\d+\/columns\/\d+\/(title|body)$/,
  /^\/slides\/\d+\/columns\/\d+\/bullets\/\d+$/,
  /^\/slides\/\d+\/columns\/\d+\/bullets\/\d+\/(text|detail)$/,
  /^\/slides\/\d+\/fragments\/\d+$/,
];
function isEditablePath(p) { return typeof p === 'string' && EDITABLE_PATTERNS.some((re) => re.test(p)); }

function applyDeckPatchPure(deck, ops) {
  if (!Array.isArray(ops)) throw new Error('ops must be an array');
  const next = JSON.parse(JSON.stringify(deck));
  for (const op of ops) {
    if (!op || typeof op !== 'object') throw new Error('malformed patch op');
    if (op.op !== 'replace') throw new Error(`only 'replace' ops are supported, got '${op.op}'`);
    if (typeof op.value !== 'string') throw new Error(`only string values are supported (path: ${op.path})`);
    if (!isEditablePath(op.path)) throw new Error(`path not editable: ${op.path}`);
    setAtPointer(next, op.path, op.value);
  }
  const validation = validateDeck(next);
  if (!validation.ok) throw new Error('patched deck invalid: ' + validation.errors.join('; '));
  return next;
}

function setAtPointer(root, pointer, value) {
  const segments = pointer.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (segments.length === 0) throw new Error('path does not resolve: ' + pointer);
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    if (Array.isArray(cursor)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) throw new Error('path does not resolve: ' + pointer);
      cursor = cursor[idx];
    } else if (cursor && typeof cursor === 'object') {
      if (!(seg in cursor)) throw new Error('path does not resolve: ' + pointer);
      cursor = cursor[seg];
    } else {
      throw new Error('path does not resolve: ' + pointer);
    }
  }
  const last = segments[segments.length - 1];
  if (Array.isArray(cursor)) {
    const idx = Number(last);
    if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) throw new Error('path does not resolve: ' + pointer);
    if (cursor[idx] !== null && typeof cursor[idx] === 'object') throw new Error('path does not resolve to a string leaf: ' + pointer);
    cursor[idx] = value;
  } else if (cursor && typeof cursor === 'object') {
    cursor[last] = value;
  } else {
    throw new Error('path does not resolve: ' + pointer);
  }
}
