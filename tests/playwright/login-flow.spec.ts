import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import type { AuthProviderInfo } from '../../src/web/api/session-api.js';

/**
 * End-to-end browser coverage for the `/login` and `/logout` dialogs.
 *
 * A real OAuth subscription flow can't reach a live provider in CI, so we
 * intercept the `/api/auth/*` endpoints at the browser layer. Everything in
 * front of the network — the slash-command routing, the LoginDialog /
 * LogoutDialog state machines, the HTTP client, polling, and the notification
 * surface — runs for real against the mock-adapter dev server booted by
 * playwright.config.ts. Only the provider's responses are canned.
 */

const AUTH_URL = 'https://login.example.test/oauth';

interface AuthRouteOptions {
  providers: AuthProviderInfo[];
  /** Events the OAuth flow emits up front (e.g. auth URL + prompt). */
  startEvents?: Array<Record<string, unknown>>;
  onLogin?: (provider: string, apiKey: string) => void;
  onLogout?: (provider: string) => void;
}

async function installAuthRoutes(page: Page, context: BrowserContext, options: AuthRouteOptions) {
  // Non-user-initiated window.open() for the auth URL may spawn a popup;
  // close popups and never let the fake auth host actually load.
  context.on('page', (popup) => void popup.close().catch(() => undefined));
  await context.route(`${AUTH_URL}**`, (route) => route.abort());

  const startEvents = options.startEvents ?? [];
  // Server-authoritative event log the client tails by cursor.
  let events: Array<Record<string, unknown>> = [];
  let inputSubmitted = false;

  const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/api/auth/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;

    if (path === '/api/auth/providers') {
      return json(route, { providers: options.providers });
    }

    if (path === '/api/auth/login' && method === 'POST') {
      const body = request.postDataJSON() as { provider: string; apiKey: string };
      options.onLogin?.(body.provider, body.apiKey);
      return json(route, { provider: { provider: body.provider, configured: true, credentialType: 'api_key', name: providerName(options.providers, body.provider) } });
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      const body = request.postDataJSON() as { provider: string };
      options.onLogout?.(body.provider);
      return json(route, { provider: { provider: body.provider, configured: false } });
    }

    if (path === '/api/auth/oauth/start' && method === 'POST') {
      events = [...startEvents];
      inputSubmitted = false;
      return json(route, { flowId: 'flow-1', provider: 'anthropic', status: 'active', cursor: events.length, events });
    }

    const flowMatch = path.match(/^\/api\/auth\/oauth\/([^/]+)(?:\/(input|cancel))?$/);
    if (flowMatch) {
      const action = flowMatch[2];
      if (!action && method === 'GET') {
        const cursor = Number(url.searchParams.get('cursor') ?? 0);
        const done = inputSubmitted;
        const full = done ? [...events, { type: 'done' }] : events;
        return json(route, { flowId: 'flow-1', provider: 'anthropic', status: done ? 'done' : 'active', cursor: full.length, events: full.slice(cursor) });
      }
      if (action === 'input' && method === 'POST') {
        inputSubmitted = true;
        return json(route, { flowId: 'flow-1', provider: 'anthropic', status: 'active', cursor: events.length, events: [] });
      }
      if (action === 'cancel' && method === 'POST') {
        return json(route, { flowId: 'flow-1', provider: 'anthropic', status: 'cancelled', cursor: events.length, events: [] });
      }
    }

    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' });
  });
}

function providerName(providers: AuthProviderInfo[], id: string): string {
  return providers.find((entry) => entry.provider === id)?.name ?? id;
}

async function openSeededSession(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: /^Seeded session\b/ }).first().click();
  await expect(page.getByLabel('Prompt draft')).toBeVisible();
}

async function runSlash(page: Page, command: string) {
  await page.getByLabel('Prompt draft').fill(command);
  await page.getByRole('button', { name: 'Send' }).click();
}

const PROVIDERS: AuthProviderInfo[] = [
  { provider: 'anthropic', name: 'Anthropic', oauthName: 'Anthropic (Claude Pro/Max)', oauthLogin: true, apiKeyLogin: true, usesCallbackServer: true, configured: false },
  { provider: 'github-copilot', name: 'GitHub Copilot', oauthName: 'GitHub Copilot', oauthLogin: true, apiKeyLogin: false, configured: false },
  { provider: 'openai', name: 'OpenAI', apiKeyLogin: true, configured: false },
  { provider: 'amazon-bedrock', name: 'Amazon Bedrock', apiKeyLogin: true, configured: false },
];

test.describe('/login dialog', () => {
  test('drives a full OAuth subscription flow to success', async ({ page, context }) => {
    await installAuthRoutes(page, context, {
      providers: PROVIDERS,
      startEvents: [
        { type: 'auth', url: AUTH_URL, instructions: 'Approve the request in your browser.' },
        { type: 'prompt', requestId: 'r1', message: 'Paste the authorization code' },
      ],
    });
    await openSeededSession(page);

    await runSlash(page, '/login');
    await expect(page.getByRole('dialog', { name: 'Sign in' })).toBeVisible();

    // Auth-type -> provider selector (subscription).
    await page.getByText('Use a subscription').click();
    const providerList = page.getByRole('list', { name: 'Providers' });
    await expect(providerList.getByText('Anthropic (Claude Pro/Max)')).toBeVisible();
    await expect(providerList.getByText('OpenAI')).toHaveCount(0);
    await providerList.getByText('Anthropic (Claude Pro/Max)').click();

    // OAuth dialog shows the auth URL + instructions, then prompts for a code.
    await expect(page.getByRole('link', { name: AUTH_URL })).toBeVisible();
    await expect(page.getByText('Approve the request in your browser.')).toBeVisible();
    await expect(page.getByText('Paste the authorization code')).toBeVisible();

    await page.getByRole('textbox', { name: 'Paste the authorization code' }).fill('auth-code-123');
    await page.getByRole('button', { name: 'Continue' }).click();

    // Polling picks up the server's 'done' event and reports success.
    await expect(page.getByLabel('Notifications').getByText('Logged in to Anthropic (Claude Pro/Max).')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Sign in' })).toHaveCount(0);
  });

  test('saves an API key', async ({ page, context }) => {
    let captured: { provider: string; apiKey: string } | null = null;
    await installAuthRoutes(page, context, {
      providers: PROVIDERS,
      onLogin: (provider, apiKey) => {
        captured = { provider, apiKey };
      },
    });
    await openSeededSession(page);

    await runSlash(page, '/login');
    await page.getByText('Use an API key').click();
    await page.getByRole('list', { name: 'Providers' }).getByText('OpenAI').click();

    await page.locator('input[type="password"]').fill('sk-secret-key');
    await page.getByRole('button', { name: 'Save key' }).click();

    await expect(page.getByLabel('Notifications').getByText('Saved API key for OpenAI.')).toBeVisible();
    expect(captured).toEqual({ provider: 'openai', apiKey: 'sk-secret-key' });
  });

  test('shows the Amazon Bedrock setup panel instead of a key prompt', async ({ page, context }) => {
    await installAuthRoutes(page, context, { providers: PROVIDERS });
    await openSeededSession(page);

    await runSlash(page, '/login');
    await page.getByText('Use an API key').click();
    await page.getByRole('list', { name: 'Providers' }).getByText('Amazon Bedrock').click();

    await expect(page.getByText(/Amazon Bedrock uses AWS credentials/)).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  });
});

test.describe('/logout dialog', () => {
  test('removes a stored API key with the right wording', async ({ page, context }) => {
    let loggedOut: string | null = null;
    await installAuthRoutes(page, context, {
      providers: [
        { provider: 'openai', name: 'OpenAI', apiKeyLogin: true, configured: true, credentialType: 'api_key' },
        { provider: 'groq', name: 'Groq', apiKeyLogin: true, configured: true, source: 'environment' },
      ],
      onLogout: (provider) => {
        loggedOut = provider;
      },
    });
    await openSeededSession(page);

    await runSlash(page, '/logout');
    await expect(page.getByRole('dialog', { name: 'Log out' })).toBeVisible();

    const list = page.getByRole('list', { name: 'Logged-in providers' });
    await expect(list.getByText('OpenAI')).toBeVisible();
    // Env-only providers have no stored credential and must not be listed.
    await expect(list.getByText('Groq')).toHaveCount(0);

    await list.getByText('OpenAI').click();
    await expect(
      page.getByLabel('Notifications').getByText('Removed stored API key for OpenAI. Environment variables and models.json config are unchanged.'),
    ).toBeVisible();
    expect(loggedOut).toBe('openai');
  });
});
