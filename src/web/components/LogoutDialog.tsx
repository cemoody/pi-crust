import { useEffect, useMemo, useState } from "react";
import type { AuthProviderInfo } from "../api/session-api.js";
import "./login-dialog.css";

export interface LogoutDialogApi {
  listAuthProviders(): Promise<{ readonly providers: readonly AuthProviderInfo[] }>;
  logout(provider: string): Promise<{ readonly provider: AuthProviderInfo }>;
}

export interface LogoutDialogProps {
  readonly open: boolean;
  readonly api: LogoutDialogApi;
  readonly onClose: () => void;
  readonly onLoggedOut?: (provider: string, message: string) => void;
}

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Mirrors the Pi TUI's `/logout` provider selector. Only providers with a
 * stored credential (saved via /login) are listed — environment variables and
 * models.json config are intentionally left alone.
 */
export function LogoutDialog({ open, api, onClose, onLoggedOut }: LogoutDialogProps) {
  const [providers, setProviders] = useState<readonly AuthProviderInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setLoading(true);
    let cancelled = false;
    void api
      .listAuthProviders()
      .then((response) => !cancelled && setProviders(response.providers))
      .catch((caught: unknown) => !cancelled && setError(errorText(caught)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [api, open]);

  const loggedIn = useMemo(
    () =>
      providers
        .filter((provider) => !!provider.credentialType)
        .slice()
        .sort((a, b) => (a.name ?? a.provider).localeCompare(b.name ?? b.provider)),
    [providers],
  );

  if (!open) return null;

  async function logout(provider: AuthProviderInfo) {
    if (pending) return;
    setPending(provider.provider);
    setError(null);
    try {
      await api.logout(provider.provider);
      const message =
        provider.credentialType === "oauth"
          ? `Logged out of ${provider.name ?? provider.provider}.`
          : `Removed stored API key for ${provider.name ?? provider.provider}. Environment variables and models.json config are unchanged.`;
      onLoggedOut?.(provider.provider, message);
      onClose();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="login-dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="login-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Log out"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header>
          <h2>Log out</h2>
          <button type="button" onClick={onClose} aria-label="Close logout dialog">×</button>
        </header>
        {error ? <p role="alert">{error}</p> : null}
        <div className="login-dialog-body">
          {loading && providers.length === 0 ? (
            <p className="login-dialog-muted">Loading providers…</p>
          ) : loggedIn.length === 0 ? (
            <p className="login-dialog-muted">
              No stored credentials to remove. Logout only removes credentials saved by /login; environment variables and models.json config are unchanged.
            </p>
          ) : (
            <ul className="login-dialog-list" aria-label="Logged-in providers">
              {loggedIn.map((provider) => (
                <li key={provider.provider}>
                  <button type="button" disabled={pending === provider.provider} onClick={() => void logout(provider)}>
                    <strong>{provider.name ?? provider.provider}</strong>
                    <span className="login-dialog-status login-dialog-status-ok">
                      {provider.credentialType === "oauth" ? "subscription" : "API key"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
