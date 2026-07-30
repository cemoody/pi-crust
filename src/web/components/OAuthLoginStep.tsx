import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthProviderInfo, OAuthLoginEvent, OAuthLoginSnapshot } from "../api/session-api.js";
import type { LoginDialogApi } from "./login-dialog-types.js";

interface ActiveRequest {
  readonly requestId: string;
  readonly kind: "prompt" | "manualCode" | "select";
  readonly message: string;
  readonly placeholder?: string;
  readonly allowEmpty?: boolean;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

export interface OAuthLoginStepProps {
  readonly api: LoginDialogApi;
  readonly provider: AuthProviderInfo;
  readonly allowBack: boolean;
  readonly onBack: () => void;
  readonly onDone: (message: string) => void;
  readonly onError: (message: string | null) => void;
}

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** Owns one OAuth handoff, including server polling and cleanup on navigation. */
export function OAuthLoginStep({ api, provider, allowBack, onBack, onDone, onError }: OAuthLoginStepProps) {
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
    // The OAuth flow is intentionally created once per provider mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.provider]);

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
  const deviceCodeEvent = useMemo(() => [...events].reverse().find((event) => event.type === "deviceCode") as Extract<OAuthLoginEvent, { type: "deviceCode" }> | undefined, [events]);

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
        if (event.type === "prompt") return {
          requestId: event.requestId, kind: "prompt", message: event.message,
          ...(event.placeholder !== undefined ? { placeholder: event.placeholder } : {}),
          ...(event.allowEmpty !== undefined ? { allowEmpty: event.allowEmpty } : {}),
        };
        if (event.type === "manualCode") return { requestId: event.requestId, kind: "manualCode", message: event.message };
        return { requestId: event.requestId, kind: "select", message: event.message, options: event.options };
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
      ) : status === "active" ? <p className="login-dialog-muted">Starting login…</p> : null}
      {deviceCodeEvent ? (
        <div className="login-dialog-device-code">
          <p>Enter this code at <a href={deviceCodeEvent.verificationUri} target="_blank" rel="noreferrer noopener">{deviceCodeEvent.verificationUri}</a>:</p>
          <code className="login-dialog-user-code">{deviceCodeEvent.userCode}</code>
          <button type="button" className="login-dialog-copy" onClick={() => void navigator.clipboard?.writeText(deviceCodeEvent.userCode).catch(() => undefined)}>Copy code</button>
        </div>
      ) : null}
      {lastProgress && status === "active" ? <p className="login-dialog-muted">{lastProgress.message}</p> : null}
      {activeRequest?.kind === "select" ? (
        <ul className="login-dialog-list" aria-label={activeRequest.message}>
          {(activeRequest.options ?? []).map((option) => <li key={option.id}><button type="button" disabled={submitting} onClick={() => void submit(activeRequest.requestId, option.id)}><strong>{option.label}</strong></button></li>)}
        </ul>
      ) : activeRequest ? (
        <label className="login-dialog-field">
          <span>{activeRequest.message}</span>
          {activeRequest.placeholder ? <span className="login-dialog-muted">e.g., {activeRequest.placeholder}</span> : null}
          <input autoFocus type="text" value={inputValue} placeholder={activeRequest.kind === "manualCode" ? "Paste redirect URL (optional)" : activeRequest.placeholder ?? ""} onChange={(event) => setInputValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (inputValue.trim() || activeRequest.allowEmpty)) void submit(activeRequest.requestId, inputValue); }} />
          <div className="login-dialog-actions"><button type="button" className="login-dialog-primary" disabled={submitting || (!inputValue.trim() && !activeRequest.allowEmpty)} onClick={() => void submit(activeRequest.requestId, inputValue)}>{submitting ? "Submitting…" : "Continue"}</button></div>
          {activeRequest.kind === "manualCode" ? <p className="login-dialog-muted">Or just finish signing in on the browser tab — this will complete automatically.</p> : null}
        </label>
      ) : null}
      {status === "error" ? <p className="login-dialog-muted">Login did not complete. You can close this dialog and try again.</p> : null}
    </div>
  );
}
