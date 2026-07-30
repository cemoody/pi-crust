import { getTabSessionId, recordClientEvent } from "../utils/client-telemetry.js";

export interface DashboardApiRequestOptions {
  readonly method?: string;
  readonly body?: unknown;
}

export type DashboardApiRequest = <T = unknown>(path: string, options?: DashboardApiRequestOptions) => Promise<T>;

/**
 * Creates the shared JSON request boundary for dashboard API methods.
 *
 * It centralizes request encoding, response decoding, and best-effort failure
 * telemetry so endpoint methods remain declarative descriptions of the API.
 */
export function createDashboardApiRequest(apiBase: string): DashboardApiRequest {
  return async function request<T>(path: string, options: DashboardApiRequestOptions = {}): Promise<T> {
    const init: RequestInit = { method: options.method ?? "GET" };
    if (options.body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(options.body);
    }
    const startedAt = Date.now();
    const response = await fetch(`${apiBase}${path}`, init);
    const text = await response.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      reportRequestFailure({ path, method: init.method ?? "GET", status: response.status, ageMs: Date.now() - startedAt, data });
      throw new Error(data?.error ?? `Request failed: ${response.status}`);
    }
    return data as T;
  };
}

function reportRequestFailure({ path, method, status, ageMs, data }: {
  readonly path: string;
  readonly method: string;
  readonly status: number;
  readonly ageMs: number;
  readonly data: unknown;
}): void {
  // Telemetry is best-effort: an unavailable telemetry endpoint must never
  // mask the server response that callers need to handle.
  try {
    recordClientEvent({
      kind: "api-error",
      method,
      path,
      status,
      ageMs,
      tabSessionId: getTabSessionId(),
      errorPreview: typeof (data as { error?: unknown } | undefined)?.error === "string"
        ? String((data as { error: string }).error).slice(0, 200)
        : undefined,
    });
  } catch { /* telemetry must never break the app */ }
}
