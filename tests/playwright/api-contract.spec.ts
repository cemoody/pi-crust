import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Server-side API contract smoke. The browser specs exercise these
 * endpoints transitively, but the contracts (status codes, required
 * fields, error shapes) are what the pi-crust depends on — and they break
 * silently when a server refactor changes a payload shape and the only
 * canary is a UI test that's looking at a different layer.
 *
 * These specs talk to the API directly via Playwright's request fixture
 * and do not open a browser. They run against the same dev-api the
 * webServer block in playwright.config.ts boots (the pi-crust is on :5174,
 * the API on :9787 by config).
 *
 * NB: the pi-crust talks to the API through Vite's dev proxy, so the
 * `baseURL` of the page is :5174. For request-only specs we hit the
 * API origin directly via VITE_PI_CRUST_API_BASE (= http://127.0.0.1:9787).
 */

const API = 'http://127.0.0.1:9787';

async function getJson(request: APIRequestContext, path: string) {
  const res = await request.get(`${API}${path}`);
  expect(res.status(), `${path} status`).toBe(200);
  return res.json();
}

test.describe('API: health + models', () => {
  test('GET /api/health → { ok, adapter, projectRoot }', async ({ request }) => {
    const body = await getJson(request, '/api/health');
    expect(body.ok).toBe(true);
    // Mock adapter is in use under playwright (PI_CRUST_USE_MOCK=1).
    expect(body.adapter).toBe('mock');
    expect(typeof body.projectRoot).toBe('string');
    expect(typeof body.sessionRoot).toBe('string');
  });

  test('GET /api/models lists at least one mock model with provider+id+name', async ({ request }) => {
    const models = await getJson(request, '/api/models');
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m).toMatchObject({
        provider: expect.any(String),
        id: expect.any(String),
        name: expect.any(String),
      });
    }
    expect(models.find((m: { id: string }) => m.id === 'mock-echo')).toBeTruthy();
  });
});

test.describe('API: session list + statuses', () => {
  test('GET /api/sessions returns each seeded session with id/cwd/sessionName/status', async ({ request }) => {
    const sessions = await getJson(request, '/api/sessions');
    expect(Array.isArray(sessions)).toBe(true);
    // Every seeded fixture should show up.
    const ids = new Set(sessions.map((s: { id: string }) => s.id));
    for (const id of [
      'seeded-session-0001',
      'seeded-session-longcode',
      'seeded-session-kitchen-sink',
      'seeded-session-shape-extras',
      'seeded-session-presentation',
      'seeded-session-structured-content',
    ]) {
      expect(ids, `seed ${id} missing from /api/sessions`).toContain(id);
    }
    // Shape contract per row.
    for (const s of sessions) {
      expect(s).toMatchObject({
        id: expect.any(String),
        cwd: expect.any(String),
        sessionName: expect.any(String),
        status: expect.any(String),
      });
    }
  });

  test('GET /api/sessions/statuses returns parallel-shaped status rows', async ({ request }) => {
    const statuses = await getJson(request, '/api/sessions/statuses');
    expect(Array.isArray(statuses)).toBe(true);
    expect(statuses.length).toBeGreaterThan(0);
    for (const s of statuses) {
      expect(s).toMatchObject({
        id: expect.any(String),
        status: expect.any(String),
      });
    }
  });
});

test.describe('API: per-session messages + state', () => {
  test('GET /api/sessions/:id/messages returns ordered records with id+role+text+timestamp', async ({ request }) => {
    const messages = await getJson(request, '/api/sessions/seeded-session-0001/messages');
    expect(messages.length).toBeGreaterThanOrEqual(2);
    // Ordering: ascending timestamp.
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].timestamp).toBeGreaterThanOrEqual(messages[i - 1].timestamp);
    }
    // Shape per record.
    for (const m of messages) {
      expect(m).toMatchObject({
        id: expect.any(String),
        role: expect.stringMatching(/^(user|assistant|tool|custom|summary)$/),
        timestamp: expect.any(Number),
      });
    }
    // The seeded assistant turn carries Markdown.
    const assistant = messages.find((m: { role: string }) => m.role === 'assistant');
    expect(assistant.text).toContain('## Plan');
  });

  test('GET /api/sessions/:id/messages?limit=1 honors the limit window', async ({ request }) => {
    const tail = await getJson(request, '/api/sessions/seeded-session-0001/messages?limit=1');
    expect(tail.length).toBe(1);
    // limit returns the tail, so it should be the assistant turn.
    expect(tail[0].role).toBe('assistant');
  });

  test('GET /api/sessions/:id/messages forwards customType + artifact details', async ({ request }) => {
    const messages = await getJson(request, '/api/sessions/seeded-session-presentation/messages');
    const artifactRow = messages.find((m: { customType?: string }) => m.customType === 'artifact');
    expect(artifactRow, 'presentation seed has a customType:"artifact" message').toBeTruthy();
    // Server strips/normalizes details; presence is the contract this
    // suite cares about, not the inner shape (covered by the pi-crust render
    // tests in presentation-artifact.spec.ts).
  });

  test('GET /api/sessions/:id/state returns idle session with stats shape', async ({ request }) => {
    const state = await getJson(request, '/api/sessions/seeded-session-0001/state');
    expect(state).toMatchObject({
      id: 'seeded-session-0001',
      status: expect.any(String),
      sessionName: expect.any(String),
      stats: expect.objectContaining({
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
        contextWindow: expect.any(Number),
      }),
    });
  });
});

test.describe('API: session lifecycle (create/rename/abort/delete)', () => {
  test('POST /api/sessions creates a session, POST /:id/rename renames, POST /:id/delete removes', async ({ request }) => {
    // The API rejects out-of-projectRoot cwds with a 500. The exact
    // projectRoot depends on where the test is running (local worktree
    // vs. GitHub runner under /home/runner/work/...), so derive it from
    // /api/health rather than hardcoding a path that only exists on the
    // author's box.
    const health = await getJson(request, '/api/health');
    const cwd = health.projectRoot as string;

    // 1. Create.
    const created = await request.post(`${API}/api/sessions`, {
      data: { cwd, sessionName: 'API contract probe' },
    });
    expect(created.status()).toBe(200);
    const session = await created.json();
    expect(session).toMatchObject({
      id: expect.any(String),
      sessionName: 'API contract probe',
      status: expect.any(String),
    });
    const id = session.id as string;

    // 2. Rename.
    const renamed = await request.post(`${API}/api/sessions/${id}/rename`, {
      data: { name: 'API contract renamed' },
    });
    expect(renamed.status()).toBe(200);
    expect((await renamed.json()).sessionName).toBe('API contract renamed');

    // 3. Abort on an idle session is a no-op but returns 200. The
    // listing path is intentionally not asserted here: freshly created
    // (zero-message) mock sessions are kept in the registry but not
    // written to .mock-session.json until they have content, and the
    // dev list endpoint only enumerates persisted files. The
    // authoritative create/rename contracts are the response bodies
    // above; delete is asserted via its own 200 below.
    const aborted = await request.post(`${API}/api/sessions/${id}/abort`);
    expect(aborted.status()).toBe(200);
    expect(await aborted.json()).toMatchObject({ ok: true });

    // 4. Delete returns 200, and deleting again returns 200 (idempotent
    // or surfaces an error — we only pin the success path here).
    const deleted = await request.post(`${API}/api/sessions/${id}/delete`);
    expect(deleted.status()).toBe(200);
  });

  test('POST /api/sessions/:id/rename without `name` returns 400 with an error', async ({ request }) => {
    const res = await request.post(`${API}/api/sessions/seeded-session-0001/rename`, { data: {} });
    expect(res.status()).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/name/i) });
  });

  test('POST /api/sessions/:id/prompt without text or attachment returns 400', async ({ request }) => {
    const res = await request.post(`${API}/api/sessions/seeded-session-0001/prompt`, { data: {} });
    expect(res.status()).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/text|attachment/i) });
  });
});

test.describe('API: error paths', () => {
  test('GET /api/no-such-endpoint returns 404 { error: "not found" }', async ({ request }) => {
    const res = await request.get(`${API}/api/no-such-endpoint`);
    expect(res.status()).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not found' });
  });

  test('GET /api/sessions/does-not-exist/messages returns a JSON error (not HTML)', async ({ request }) => {
    const res = await request.get(`${API}/api/sessions/does-not-exist/messages`);
    // The server currently returns 500 with a structured error for unknown
    // sessions, not 404. We pin the structured-error contract (the pi-crust
    // depends on `body.error` being a string); status code is allowed to
    // be either 404 or 5xx to leave room for the server to tighten this
    // without churning the spec.
    expect([404, 500]).toContain(res.status());
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(body.error.toLowerCase()).toContain('does-not-exist');
  });
});
