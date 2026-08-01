export function resolvePiRemoteApiBase(): string {
  if (process.env.PI_CRUST_API_BASE) return trimTrailingSlash(process.env.PI_CRUST_API_BASE);
  const configuredHost = process.env.PI_CRUST_API_HOST ?? "127.0.0.1";
  const host = configuredHost === "0.0.0.0" || configuredHost === "::" ? "127.0.0.1" : configuredHost;
  const port = process.env.PI_CRUST_API_PORT ?? "8787";
  return `http://${host}:${port}`;
}

export function resolvePiRemoteUiBase(apiBase: string): string {
  if (process.env.PI_CRUST_UI_BASE) return trimTrailingSlash(process.env.PI_CRUST_UI_BASE);
  return apiBase;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const message = typeof data === "object" && data !== null && "error" in data
      ? String((data as { error: unknown }).error)
      : `HTTP ${response.status}`;
    throw new Error(`POST ${url} failed: ${message}`);
  }
  return data as T;
}
