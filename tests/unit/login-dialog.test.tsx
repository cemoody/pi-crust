// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProviderInfo, OAuthLoginSnapshot } from "../../src/web/api/session-api.js";
import { LoginDialog, type LoginDialogApi } from "../../src/web/components/LoginDialog.js";
import { LogoutDialog, type LogoutDialogApi } from "../../src/web/components/LogoutDialog.js";

/**
 * These expectations mirror the Pi TUI's `/login` and `/logout` flows
 * (interactive-mode.js + oauth-selector.js + login-dialog.js):
 *
 *  1. `/login` -> auth-type selector (subscription vs API key).
 *  2. Auth-type options disable when no providers of that type exist.
 *  3. Provider selector filtered by auth type, sorted by name, searchable.
 *  4. Per-provider status indicators (configured / other-type credential /
 *     env / runtime / models.json / unconfigured).
 *  5. OAuth dialog: show + auto-open auth URL, instructions, progress,
 *     prompt (with "e.g." placeholder hint), select sub-prompt, manual-code
 *     race for callback-server providers.
 *  6. OAuth success -> "Logged in to <name>"; cancel on close.
 *  7. API-key dialog: empty key error, success "Saved API key for <name>".
 *  8. Amazon Bedrock -> informational panel, no API-key prompt.
 *  9. `/logout` -> selector of stored-credential providers only, with the
 *     subscription vs API-key result wording, and an empty-state message.
 */

const PROVIDERS: AuthProviderInfo[] = [
  { provider: "anthropic", name: "Anthropic", oauthName: "Anthropic (Claude Pro/Max)", oauthLogin: true, apiKeyLogin: true, usesCallbackServer: true, configured: false },
  { provider: "github-copilot", name: "GitHub Copilot", oauthName: "GitHub Copilot", oauthLogin: true, apiKeyLogin: false, configured: false },
  { provider: "openai", name: "OpenAI", apiKeyLogin: true, configured: true, credentialType: "api_key", source: "stored" },
  { provider: "groq", name: "Groq", apiKeyLogin: true, configured: true, source: "environment", label: "GROQ_API_KEY" },
  { provider: "amazon-bedrock", name: "Amazon Bedrock", apiKeyLogin: true, configured: false },
];

function makeApi(overrides: Partial<LoginDialogApi> = {}): LoginDialogApi {
  return {
    listAuthProviders: vi.fn(async () => ({ providers: PROVIDERS })),
    login: vi.fn(async () => ({})),
    startOAuthLogin: vi.fn(async () => snapshot("f1", "active", 0, [])),
    pollOAuthLogin: vi.fn(async () => snapshot("f1", "active", 0, [])),
    submitOAuthLogin: vi.fn(async () => snapshot("f1", "active", 0, [])),
    cancelOAuthLogin: vi.fn(async () => snapshot("f1", "cancelled", 0, [])),
    ...overrides,
  };
}

function snapshot(flowId: string, status: OAuthLoginSnapshot["status"], cursor: number, events: OAuthLoginSnapshot["events"], error?: string): OAuthLoginSnapshot {
  return { flowId, provider: "anthropic", status, cursor, events, ...(error ? { error } : {}) };
}

beforeEach(() => {
  vi.stubGlobal("open", vi.fn());
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LoginDialog — auth-type and provider selection", () => {
  it("opens to the auth-type selector with both methods enabled", async () => {
    render(<LoginDialog open api={makeApi()} onClose={vi.fn()} />);
    await screen.findByRole("dialog", { name: "Sign in" });
    expect(screen.getByText("Use a subscription")).toBeEnabled();
    expect(screen.getByText("Use an API key")).toBeEnabled();
  });

  it("disables a method when no provider supports it", async () => {
    const api = makeApi({ listAuthProviders: vi.fn(async () => ({ providers: [{ provider: "mock", name: "Mock", apiKeyLogin: true, configured: false }] })) });
    render(<LoginDialog open api={api} onClose={vi.fn()} />);
    await screen.findByRole("dialog", { name: "Sign in" });
    expect(screen.getByText("Use a subscription").closest("button")).toBeDisabled();
    expect(screen.getByText("Use an API key").closest("button")).toBeEnabled();
  });

  it("subscription list shows only oauthLogin providers, by subscription name, sorted", async () => {
    render(<LoginDialog open api={makeApi()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText("Use a subscription"));
    const list = await screen.findByRole("list", { name: "Providers" });
    expect(within(list).getByText("Anthropic (Claude Pro/Max)")).toBeInTheDocument();
    expect(within(list).getByText("GitHub Copilot")).toBeInTheDocument();
    expect(within(list).queryByText("OpenAI")).not.toBeInTheDocument();
  });

  it("API-key list shows apiKeyLogin providers including those that also support OAuth", async () => {
    render(<LoginDialog open api={makeApi()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText("Use an API key"));
    const list = await screen.findByRole("list", { name: "Providers" });
    expect(within(list).getByText("Anthropic")).toBeInTheDocument();
    expect(within(list).getByText("OpenAI")).toBeInTheDocument();
    expect(within(list).queryByText("GitHub Copilot")).not.toBeInTheDocument();
  });

  it("filters the provider list with the search box", async () => {
    render(<LoginDialog open api={makeApi()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText("Use an API key"));
    fireEvent.change(await screen.findByLabelText("Search providers"), { target: { value: "groq" } });
    const list = screen.getByRole("list", { name: "Providers" });
    expect(within(list).getByText("Groq")).toBeInTheDocument();
    expect(within(list).queryByText("OpenAI")).not.toBeInTheDocument();
  });

  it("renders the right status indicator per provider", async () => {
    render(<LoginDialog open api={makeApi()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText("Use an API key"));
    await screen.findByRole("list", { name: "Providers" });
    // Stored api_key credential => configured
    expect(screen.getByText("✓ configured")).toBeInTheDocument();
    // Env-var key => env: LABEL
    expect(screen.getByText("✓ env: GROQ_API_KEY")).toBeInTheDocument();
    // Bedrock has nothing => unconfigured
    expect(screen.getAllByText("unconfigured").length).toBeGreaterThan(0);
  });

  it("Back returns to the auth-type selector", async () => {
    render(<LoginDialog open api={makeApi()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText("Use a subscription"));
    fireEvent.click(await screen.findByText("← Back"));
    expect(await screen.findByText("Select authentication method:")).toBeInTheDocument();
  });
});

describe("LoginDialog — OAuth flow", () => {
  it("shows and auto-opens the auth URL, then renders a prompt with placeholder hint", async () => {
    const events = [
      { type: "auth" as const, url: "https://example.com/auth", instructions: "Approve in the browser" },
      { type: "prompt" as const, requestId: "r1", message: "Paste the code", placeholder: "ABC-123" },
    ];
    const api = makeApi({ startOAuthLogin: vi.fn(async () => snapshot("f1", "active", events.length, events)) });
    render(<LoginDialog open api={api} initialProvider="anthropic" onClose={vi.fn()} />);

    expect(await screen.findByText("https://example.com/auth")).toBeInTheDocument();
    expect(screen.getByText("Approve in the browser")).toBeInTheDocument();
    await waitFor(() => expect(window.open).toHaveBeenCalledWith("https://example.com/auth", "_blank", "noopener,noreferrer"));
    expect(screen.getByText("Paste the code")).toBeInTheDocument();
    expect(screen.getByText("e.g., ABC-123")).toBeInTheDocument();
  });

  it("submits a prompt answer to the server", async () => {
    const events = [{ type: "prompt" as const, requestId: "r1", message: "Paste the code" }];
    const submitOAuthLogin = vi.fn(async () => snapshot("f1", "active", events.length, []));
    const api = makeApi({ startOAuthLogin: vi.fn(async () => snapshot("f1", "active", events.length, events)), submitOAuthLogin });
    render(<LoginDialog open api={api} initialProvider="anthropic" onClose={vi.fn()} />);

    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "the-code" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(submitOAuthLogin).toHaveBeenCalledWith("f1", "r1", "the-code"));
  });

  it("renders a select sub-prompt and submits the chosen option id", async () => {
    const events = [{ type: "select" as const, requestId: "s1", message: "Choose an account", options: [{ id: "team", label: "Team" }, { id: "personal", label: "Personal" }] }];
    const submitOAuthLogin = vi.fn(async () => snapshot("f1", "active", events.length, []));
    const api = makeApi({ startOAuthLogin: vi.fn(async () => snapshot("f1", "active", events.length, events)), submitOAuthLogin });
    render(<LoginDialog open api={api} initialProvider="anthropic" onClose={vi.fn()} />);

    fireEvent.click(await screen.findByText("Team"));
    await waitFor(() => expect(submitOAuthLogin).toHaveBeenCalledWith("f1", "s1", "team"));
  });

  it("offers an optional manual-code box for callback-server providers", async () => {
    const events = [
      { type: "auth" as const, url: "https://example.com/auth" },
      { type: "manualCode" as const, requestId: "m1", message: "Paste the redirect URL" },
    ];
    const api = makeApi({ startOAuthLogin: vi.fn(async () => snapshot("f1", "active", events.length, events)) });
    render(<LoginDialog open api={api} initialProvider="anthropic" onClose={vi.fn()} />);
    expect(await screen.findByText("Paste the redirect URL")).toBeInTheDocument();
    expect(screen.getByText(/finish signing in on the browser tab/)).toBeInTheDocument();
  });

  it("reports success with 'Logged in to <subscription name>' and does not cancel", async () => {
    const onLoggedIn = vi.fn();
    const onClose = vi.fn();
    const cancelOAuthLogin = vi.fn(async () => snapshot("f1", "cancelled", 0, []));
    const api = makeApi({ startOAuthLogin: vi.fn(async () => snapshot("f1", "done", 0, [{ type: "done" }])), cancelOAuthLogin });
    render(<LoginDialog open api={api} initialProvider="anthropic" onClose={onClose} onLoggedIn={onLoggedIn} />);
    await waitFor(() => expect(onLoggedIn).toHaveBeenCalledWith("anthropic", "oauth", "Logged in to Anthropic (Claude Pro/Max)."));
    expect(cancelOAuthLogin).not.toHaveBeenCalled();
  });

  it("cancels the flow when the dialog is closed mid-login", async () => {
    const cancelOAuthLogin = vi.fn(async () => snapshot("f1", "cancelled", 0, []));
    const api = makeApi({ startOAuthLogin: vi.fn(async () => snapshot("f1", "active", 0, [{ type: "auth", url: "https://x" }])), cancelOAuthLogin });
    const onClose = vi.fn();
    const { rerender } = render(<LoginDialog open api={api} initialProvider="anthropic" onClose={onClose} />);
    await screen.findByText("https://x");
    rerender(<LoginDialog open={false} api={api} initialProvider="anthropic" onClose={onClose} />);
    await waitFor(() => expect(cancelOAuthLogin).toHaveBeenCalledWith("f1"));
  });

  it("surfaces a server error message", async () => {
    const api = makeApi({ startOAuthLogin: vi.fn(async () => snapshot("f1", "error", 1, [{ type: "error", message: "provider exploded" }], "provider exploded")) });
    render(<LoginDialog open api={api} initialProvider="anthropic" onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("provider exploded");
  });
});

describe("LoginDialog — API key flow", () => {
  it("rejects an empty key with the TUI's error message", async () => {
    const login = vi.fn();
    const api = makeApi({ login });
    render(<LoginDialog open api={api} initialProvider="openai" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save key" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("API key cannot be empty.");
    expect(login).not.toHaveBeenCalled();
  });

  it("saves a key and reports 'Saved API key for <name>'", async () => {
    const onLoggedIn = vi.fn();
    const login = vi.fn(async () => ({}));
    const api = makeApi({ login });
    render(<LoginDialog open api={api} initialProvider="openai" onClose={vi.fn()} onLoggedIn={onLoggedIn} />);
    fireEvent.change(await screen.findByLabelText("Enter API key:"), { target: { value: "sk-xyz" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(login).toHaveBeenCalledWith("openai", "sk-xyz"));
    expect(onLoggedIn).toHaveBeenCalledWith("openai", "api_key", "Saved API key for OpenAI.");
  });

  it("shows the Amazon Bedrock setup panel instead of a key prompt", async () => {
    render(<LoginDialog open api={makeApi()} initialProvider="amazon-bedrock" onClose={vi.fn()} />);
    expect(await screen.findByText(/Amazon Bedrock uses AWS credentials/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Enter API key:")).not.toBeInTheDocument();
  });
});

describe("LogoutDialog", () => {
  function logoutApi(providers: AuthProviderInfo[], logout = vi.fn(async (provider: string) => ({ provider: { provider, configured: false } }))): LogoutDialogApi {
    return { listAuthProviders: vi.fn(async () => ({ providers })), logout };
  }

  it("lists only providers with a stored credential", async () => {
    render(<LogoutDialog open api={logoutApi(PROVIDERS)} onClose={vi.fn()} />);
    const list = await screen.findByRole("list", { name: "Logged-in providers" });
    expect(within(list).getByText("OpenAI")).toBeInTheDocument(); // stored api_key
    // groq is env-only (no credentialType) -> excluded
    expect(within(list).queryByText("Groq")).not.toBeInTheDocument();
    expect(within(list).queryByText("Anthropic")).not.toBeInTheDocument();
  });

  it("shows the empty-state message when nothing is stored", async () => {
    render(<LogoutDialog open api={logoutApi([{ provider: "groq", name: "Groq", apiKeyLogin: true, configured: true, source: "environment" }])} onClose={vi.fn()} />);
    expect(await screen.findByText(/No stored credentials to remove/)).toBeInTheDocument();
  });

  it("phrases API-key removal differently from subscription logout", async () => {
    const onLoggedOut = vi.fn();
    const providers: AuthProviderInfo[] = [
      { provider: "openai", name: "OpenAI", apiKeyLogin: true, configured: true, credentialType: "api_key" },
      { provider: "anthropic", name: "Anthropic", oauthLogin: true, apiKeyLogin: true, configured: true, credentialType: "oauth" },
    ];
    render(<LogoutDialog open api={logoutApi(providers)} onClose={vi.fn()} onLoggedOut={onLoggedOut} />);
    fireEvent.click(await screen.findByText("OpenAI"));
    await waitFor(() => expect(onLoggedOut).toHaveBeenCalledWith("openai", "Removed stored API key for OpenAI. Environment variables and models.json config are unchanged."));
  });

  it("phrases subscription logout as 'Logged out of <name>'", async () => {
    const onLoggedOut = vi.fn();
    const providers: AuthProviderInfo[] = [{ provider: "anthropic", name: "Anthropic", oauthLogin: true, configured: true, credentialType: "oauth" }];
    render(<LogoutDialog open api={logoutApi(providers)} onClose={vi.fn()} onLoggedOut={onLoggedOut} />);
    fireEvent.click(await screen.findByText("Anthropic"));
    await waitFor(() => expect(onLoggedOut).toHaveBeenCalledWith("anthropic", "Logged out of Anthropic."));
  });
});
