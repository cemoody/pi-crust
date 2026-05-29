import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthProviderInfo, OAuthLoginEvent, OAuthLoginSnapshot } from "../api/session-api.js";
import "./login-dialog.css";

export interface LoginDialogApi {
  listAuthProviders(): Promise<{ readonly providers: readonly AuthProviderInfo[] }>;
  login(provider: string, apiKey: string): Promise<unknown>;
  startOAuthLogin(provider: string): Promise<OAuthLoginSnapshot>;
  pollOAuthLogin(flowId: string, cursor: number): Promise<OAuthLoginSnapshot>;
  submitOAuthLogin(flowId: string, requestId: string, value: string): Promise<OAuthLoginSnapshot>;
  cancelOAuthLogin(flowId: string): Promise<OAuthLoginSnapshot>;
}

export interface LoginDialogProps {
  readonly open: boolean;
  readonly api: LoginDialogApi;
  /** Skip the auth-type/provider pickers and go straight to this provider. */
  readonly initialProvider?: string;
  readonly onClose: () => void;
  readonly onLoggedIn?: (provider: string, authType: "oauth" | "api_key", message: string) => void;
}

const BEDROCK_PROVIDER_ID = "amazon-bedrock";

type Step =
  | { readonly kind: "authType" }
  | { readonly kind: "provider"; readonly authType: "oauth" | "api_key" }
  | { readonly kind: "apiKey"; readonly provider: AuthProviderInfo }
  | { readonly kind: "oauth"; readonly provider: AuthProviderInfo };

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function providerLabel(provider: AuthProviderInfo, authType: "oauth" | "api_key"): string {
  if (authType === "oauth") return provider.oauthName ?? provider.name ?? provider.provider;
  return provider.name ?? provider.provider;
}

/**
 * Status indicator mirroring the Pi TUI's OAuthSelectorComponent
 * `formatStatusIndicator`: shows whether the provider already has a credential
 * of the matching type, a credential of the *other* type, an env/runtime/
 * models.json key, or is unconfigured.
 */
function statusIndicator(provider: AuthProviderInfo, authType: "oauth" | "api_key"): { text: string; tone: "ok" | "warn" | "muted" } {
  const credType = provider.credentialType;
  const wantType = authType === "oauth" ? "oauth" : "api_key";
  if (credType === wantType) return { text: "✓ configured", tone: "ok" };
  if (credType) return { text: credType === "oauth" ? "subscription configured" : "API key configured", tone: "warn" };
  if (authType !== "api_key") return { text: "unconfigured", tone: "muted" };
  switch (provider.source) {
    case "environment":
      return { text: `✓ env: ${provider.label ?? "API key"}`, tone: "ok" };
    case "runtime":
      return { text: "✓ runtime API key", tone: "ok" };
    case "fallback":
      return { text: "✓ custom API key", tone: "ok" };
    case "models_json_key":
      return { text: "✓ key in models.json", tone: "ok" };
    case "models_json_command":
      return { text: "✓ command in models.json", tone: "ok" };
    default:
      return { text: "unconfigured", tone: "muted" };
  }
}

export function LoginDialog({ open, api, initialProvider, onClose, onLoggedIn }: LoginDialogProps) {
  const [providers, setProviders] = useState<readonly AuthProviderInfo[]>([]);
  const [step, setStep] = useState<Step>({ kind: "authType" });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Load providers and resolve the initial step whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setLoading(true);
    let cancelled = false;
    void api
      .listAuthProviders()
      .then((response) => {
        if (cancelled) return;
        setProviders(response.providers);
        if (initialProvider) {
          const match = response.providers.find((provider) => provider.provider === initialProvider);
          if (match) {
            setStep(match.oauthLogin ? { kind: "oauth", provider: match } : { kind: "apiKey", provider: match });
            return;
          }
          // Unknown provider id: treat it as an API-key provider so the user
          // can still paste a key for a models.json custom provider.
          setStep({ kind: "apiKey", provider: { provider: initialProvider, configured: false, name: initialProvider, apiKeyLogin: true } });
          return;
        }
        setStep({ kind: "authType" });
      })
      .catch((caught: unknown) => !cancelled && setError(errorText(caught)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [api, initialProvider, open]);

  if (!open) return null;

  const canGoBack = !initialProvider && step.kind !== "authType";
  const goBack = () => setStep({ kind: "authType" });

  return (
    <div className="login-dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="login-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Sign in"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            if (canGoBack) goBack();
            else onClose();
          }
        }}
      >
        <header>
          <h2>{headerTitle(step)}</h2>
          <button type="button" onClick={onClose} aria-label="Close login dialog">×</button>
        </header>
        {error ? <p role="alert">{error}</p> : null}
        {loading && step.kind === "authType" && providers.length === 0 ? (
          <p className="login-dialog-muted">Loading providers…</p>
        ) : step.kind === "authType" ? (
          <AuthTypeStep providers={providers} onPick={(authType) => setStep({ kind: "provider", authType })} />
        ) : step.kind === "provider" ? (
          <ProviderStep
            providers={providers}
            authType={step.authType}
            onBack={goBack}
            onPick={(provider) => setStep(step.authType === "oauth" ? { kind: "oauth", provider } : { kind: "apiKey", provider })}
          />
        ) : step.kind === "apiKey" ? (
          <ApiKeyStep
            api={api}
            provider={step.provider}
            allowBack={canGoBack}
            onBack={goBack}
            onError={setError}
            onDone={(message) => {
              onLoggedIn?.(step.provider.provider, "api_key", message);
              onClose();
            }}
          />
        ) : (
          <OAuthStep
            api={api}
            provider={step.provider}
            allowBack={canGoBack}
            onBack={goBack}
            onError={setError}
            onDone={(message) => {
              onLoggedIn?.(step.provider.provider, "oauth", message);
              onClose();
            }}
          />
        )}
      </div>
    </div>
  );
}

function headerTitle(step: Step): string {
  switch (step.kind) {
    case "authType":
      return "Sign in";
    case "provider":
      return step.authType === "oauth" ? "Select a subscription provider" : "Select a provider";
    case "apiKey":
      return `Log in to ${step.provider.name ?? step.provider.provider}`;
    case "oauth":
      return `Log in to ${step.provider.oauthName ?? step.provider.name ?? step.provider.provider}`;
  }
}

function AuthTypeStep({ providers, onPick }: { providers: readonly AuthProviderInfo[]; onPick: (authType: "oauth" | "api_key") => void }) {
  const hasOAuth = providers.some((provider) => provider.oauthLogin);
  const hasApiKey = providers.some((provider) => provider.apiKeyLogin);
  return (
    <div className="login-dialog-body">
      <p className="login-dialog-muted">Select authentication method:</p>
      <ul className="login-dialog-list">
        <li>
          <button type="button" disabled={!hasOAuth} onClick={() => onPick("oauth")}>
            <strong>Use a subscription</strong>
            <span>Log in with your provider account in the browser (OAuth).</span>
          </button>
        </li>
        <li>
          <button type="button" disabled={!hasApiKey} onClick={() => onPick("api_key")}>
            <strong>Use an API key</strong>
            <span>Paste a provider API key.</span>
          </button>
        </li>
      </ul>
    </div>
  );
}

function ProviderStep({
  providers,
  authType,
  onBack,
  onPick,
}: {
  readonly providers: readonly AuthProviderInfo[];
  readonly authType: "oauth" | "api_key";
  readonly onBack: () => void;
  readonly onPick: (provider: AuthProviderInfo) => void;
}) {
  const [query, setQuery] = useState("");
  const candidates = useMemo(
    () =>
      providers
        .filter((provider) => (authType === "oauth" ? provider.oauthLogin : provider.apiKeyLogin))
        .slice()
        .sort((a, b) => providerLabel(a, authType).localeCompare(providerLabel(b, authType))),
    [authType, providers],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return candidates;
    return candidates.filter((provider) => `${providerLabel(provider, authType)} ${provider.provider}`.toLowerCase().includes(needle));
  }, [authType, candidates, query]);

  return (
    <div className="login-dialog-body">
      <button type="button" className="login-dialog-back" onClick={onBack}>← Back</button>
      <input
        autoFocus
        className="login-dialog-search"
        placeholder="Search providers"
        aria-label="Search providers"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul className="login-dialog-list" aria-label="Providers">
        {filtered.map((provider) => {
          const indicator = statusIndicator(provider, authType);
          return (
            <li key={provider.provider}>
              <button type="button" onClick={() => onPick(provider)}>
                <strong>{providerLabel(provider, authType)}</strong>
                <span className={`login-dialog-status login-dialog-status-${indicator.tone}`}>{indicator.text}</span>
              </button>
            </li>
          );
        })}
        {filtered.length === 0 ? (
          <li className="login-dialog-empty">{candidates.length === 0 ? "No providers available." : "No matching providers."}</li>
        ) : null}
      </ul>
    </div>
  );
}

function ApiKeyStep({
  api,
  provider,
  allowBack,
  onBack,
  onDone,
  onError,
}: {
  readonly api: LoginDialogApi;
  readonly provider: AuthProviderInfo;
  readonly allowBack: boolean;
  readonly onBack: () => void;
  readonly onDone: (message: string) => void;
  readonly onError: (message: string | null) => void;
}) {
  const [key, setKey] = useState("");
  const [pending, setPending] = useState(false);

  // Amazon Bedrock uses AWS credentials rather than a single API key, so the
  // TUI shows an informational panel instead of a key prompt. Mirror that.
  if (provider.provider === BEDROCK_PROVIDER_ID) {
    return (
      <div className="login-dialog-body">
        {allowBack ? <button type="button" className="login-dialog-back" onClick={onBack}>← Back</button> : null}
        <div className="login-dialog-auth">
          <p>Amazon Bedrock uses AWS credentials instead of a single API key.</p>
          <p className="login-dialog-muted">Configure an AWS profile, IAM keys, a bearer token, or role-based credentials, then pick a Bedrock model with /model.</p>
          <a href="https://docs.aws.amazon.com/bedrock/latest/userguide/security-iam.html" target="_blank" rel="noreferrer noopener">AWS Bedrock credentials documentation</a>
        </div>
        <div className="login-dialog-actions">
          <button type="button" className="login-dialog-primary" onClick={() => onDone(`Reviewed Amazon Bedrock setup.`)}>Done</button>
        </div>
      </div>
    );
  }

  async function submit() {
    if (pending) return;
    if (!key.trim()) {
      onError("API key cannot be empty.");
      return;
    }
    setPending(true);
    onError(null);
    try {
      await api.login(provider.provider, key.trim());
      onDone(`Saved API key for ${provider.name ?? provider.provider}.`);
    } catch (caught) {
      onError(errorText(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="login-dialog-body">
      {allowBack ? <button type="button" className="login-dialog-back" onClick={onBack}>← Back</button> : null}
      <label className="login-dialog-field">
        <span>Enter API key:</span>
        <input
          autoFocus
          type="password"
          value={key}
          placeholder="Paste your API key"
          onChange={(event) => setKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
        />
      </label>
      <div className="login-dialog-actions">
        <button type="button" className="login-dialog-primary" disabled={pending} onClick={() => void submit()}>
          {pending ? "Saving…" : "Save key"}
        </button>
      </div>
    </div>
  );
}

interface ActiveRequest {
  readonly requestId: string;
  readonly kind: "prompt" | "manualCode" | "select";
  readonly message: string;
  readonly placeholder?: string;
  readonly allowEmpty?: boolean;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

function OAuthStep({
  api,
  provider,
  allowBack,
  onBack,
  onDone,
  onError,
}: {
  readonly api: LoginDialogApi;
  readonly provider: AuthProviderInfo;
  readonly allowBack: boolean;
  readonly onBack: () => void;
  readonly onDone: (message: string) => void;
  readonly onError: (message: string | null) => void;
}) {
  const [events, setEvents] = useState<readonly OAuthLoginEvent[]>([]);
  const [status, setStatus] = useState<OAuthLoginSnapshot["status"]>("active");
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [inputValue, setInputValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const flowIdRef = useRef<string | null>(null);
  const cursorRef = useRef(0);
  const doneRef = useRef(false);
  const openedUrlRef = useRef<string | null>(null);

  const ingest = useCallback((snapshot: OAuthLoginSnapshot) => {
    flowIdRef.current = snapshot.flowId;
    cursorRef.current = snapshot.cursor;
    setStatus(snapshot.status);
    if (snapshot.events.length > 0) setEvents((current) => [...current, ...snapshot.events]);
    if (snapshot.error) onError(snapshot.error);
  }, [onError]);

  // Start the flow on mount; cancel it if the user closes/navigates away
  // before it finishes so the server isn't left holding a pending login().
  useEffect(() => {
    let active = true;
    onError(null);
    void api
      .startOAuthLogin(provider.provider)
      .then((snapshot) => active && ingest(snapshot))
      .catch((caught: unknown) => active && onError(errorText(caught)));
    return () => {
      active = false;
      const flowId = flowIdRef.current;
      if (flowId && !doneRef.current) void Promise.resolve(api.cancelOAuthLogin(flowId)).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.provider]);

  // Poll for new events while the flow is active.
  useEffect(() => {
    if (status !== "active") {
      if (status === "done") {
        doneRef.current = true;
        onDone(`Logged in to ${provider.oauthName ?? provider.name ?? provider.provider}.`);
      }
      return;
    }
    let active = true;
    const timer = setInterval(() => {
      const flowId = flowIdRef.current;
      if (!flowId) return;
      void api
        .pollOAuthLogin(flowId, cursorRef.current)
        .then((snapshot) => active && ingest(snapshot))
        .catch(() => undefined);
    }, 800);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, ingest, onDone, provider.name, provider.oauthName, provider.provider, status]);

  const authEvent = useMemo(() => [...events].reverse().find((event) => event.type === "auth") as Extract<OAuthLoginEvent, { type: "auth" }> | undefined, [events]);
  const lastProgress = useMemo(() => [...events].reverse().find((event) => event.type === "progress") as Extract<OAuthLoginEvent, { type: "progress" }> | undefined, [events]);

  // Auto-open the auth URL in a new tab, like the TUI's exec(open/xdg-open).
  useEffect(() => {
    if (authEvent && openedUrlRef.current !== authEvent.url) {
      openedUrlRef.current = authEvent.url;
      try {
        window.open(authEvent.url, "_blank", "noopener,noreferrer");
      } catch {
        /* popup blocked — the link is shown for manual opening */
      }
    }
  }, [authEvent]);

  const activeRequest = useMemo<ActiveRequest | undefined>(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if ((event.type === "prompt" || event.type === "manualCode" || event.type === "select") && !answered.has(event.requestId)) {
        if (event.type === "prompt") {
          const request: ActiveRequest = {
            requestId: event.requestId,
            kind: "prompt",
            message: event.message,
            ...(event.placeholder !== undefined ? { placeholder: event.placeholder } : {}),
            ...(event.allowEmpty !== undefined ? { allowEmpty: event.allowEmpty } : {}),
          };
          return request;
        }
        if (event.type === "manualCode") {
          const request: ActiveRequest = { requestId: event.requestId, kind: "manualCode", message: event.message };
          return request;
        }
        const request: ActiveRequest = { requestId: event.requestId, kind: "select", message: event.message, options: event.options };
        return request;
      }
    }
    return undefined;
  }, [answered, events]);

  async function submit(requestId: string, value: string) {
    const flowId = flowIdRef.current;
    if (!flowId || submitting) return;
    setSubmitting(true);
    onError(null);
    try {
      const snapshot = await api.submitOAuthLogin(flowId, requestId, value);
      setAnswered((current) => new Set(current).add(requestId));
      setInputValue("");
      ingest(snapshot);
    } catch (caught) {
      onError(errorText(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-dialog-body">
      {allowBack && status === "active" && !authEvent ? <button type="button" className="login-dialog-back" onClick={onBack}>← Back</button> : null}

      {authEvent ? (
        <div className="login-dialog-auth">
          <p>Open this URL in your browser to continue:</p>
          <a href={authEvent.url} target="_blank" rel="noreferrer noopener">{authEvent.url}</a>
          <button type="button" className="login-dialog-copy" onClick={() => void navigator.clipboard?.writeText(authEvent.url).catch(() => undefined)}>Copy link</button>
          {authEvent.instructions ? <p className="login-dialog-instructions">{authEvent.instructions}</p> : null}
        </div>
      ) : status === "active" ? (
        <p className="login-dialog-muted">Starting login…</p>
      ) : null}

      {lastProgress && status === "active" ? <p className="login-dialog-muted">{lastProgress.message}</p> : null}

      {activeRequest?.kind === "select" ? (
        <ul className="login-dialog-list" aria-label={activeRequest.message}>
          {(activeRequest.options ?? []).map((option) => (
            <li key={option.id}>
              <button type="button" disabled={submitting} onClick={() => void submit(activeRequest.requestId, option.id)}>
                <strong>{option.label}</strong>
              </button>
            </li>
          ))}
        </ul>
      ) : activeRequest ? (
        <label className="login-dialog-field">
          <span>{activeRequest.message}</span>
          {activeRequest.placeholder ? <span className="login-dialog-muted">e.g., {activeRequest.placeholder}</span> : null}
          <input
            autoFocus
            type="text"
            value={inputValue}
            placeholder={activeRequest.kind === "manualCode" ? "Paste redirect URL (optional)" : activeRequest.placeholder ?? ""}
            onChange={(event) => setInputValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (inputValue.trim() || activeRequest.allowEmpty)) void submit(activeRequest.requestId, inputValue);
            }}
          />
          <div className="login-dialog-actions">
            <button
              type="button"
              className="login-dialog-primary"
              disabled={submitting || (!inputValue.trim() && !activeRequest.allowEmpty)}
              onClick={() => void submit(activeRequest.requestId, inputValue)}
            >
              {submitting ? "Submitting…" : "Continue"}
            </button>
          </div>
          {activeRequest.kind === "manualCode" ? (
            <p className="login-dialog-muted">Or just finish signing in on the browser tab — this will complete automatically.</p>
          ) : null}
        </label>
      ) : null}

      {status === "error" ? <p className="login-dialog-muted">Login did not complete. You can close this dialog and try again.</p> : null}
    </div>
  );
}
