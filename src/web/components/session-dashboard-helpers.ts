/**
 * Pure utility functions used by SessionDashboard.tsx. Extracted so the
 * dashboard component itself can stay focused on React state + JSX wiring.
 *
 * None of these helpers depend on React, the dashboard's component state,
 * or its JSX. They are safe to import from anywhere in the web bundle.
 */
import { isRecord, optional } from "../../shared/util.js";
import type { ExtensionUiRequest } from "../../shared/protocol.js";
import type { BranchMessageOption, DashboardArtifact, PromptAttachment, SessionCardData, SessionCardStats } from "../api/session-api.js";

// Re-export the canonical wire-content helpers so existing import paths
// keep working. Behavior change vs. the prior local copy: unknown blocks
// (toolCall, extension types) are now silently skipped instead of being
// JSON-stringified into `text`. See src/shared/wire-content.ts.
export { contentText, contentTextAndThinking, toolResultText } from "../../shared/wire-content.js";

export function extractArtifact(result: unknown): DashboardArtifact | undefined {
  if (!isRecord(result) || !isRecord(result.details)) return undefined;
  const artifact = result.details.piRemoteControlArtifact;
  if (!isRecord(artifact) || typeof artifact.kind !== "string") return undefined;
  return artifact as unknown as DashboardArtifact;
}

// ---------- extension-UI request bookkeeping ----------

export function upsertExtensionUiRequest(requests: readonly ExtensionUiRequest[], request: ExtensionUiRequest): ExtensionUiRequest[] {
  const withoutSameTarget = requests.filter((existing) => {
    if (existing.id === request.id) return false;
    if (existing.method === "setStatus" && request.method === "setStatus") return existing.statusKey !== request.statusKey;
    if (existing.method === "setWidget" && request.method === "setWidget") return existing.widgetKey !== request.widgetKey;
    if (existing.method === "setTitle" && request.method === "setTitle") return false;
    return true;
  });
  return [...withoutSameTarget, request];
}

export function isExtensionUiRequest(value: Record<string, unknown>): value is ExtensionUiRequest {
  const method = value.method;
  if (typeof value.id !== "string" || typeof method !== "string") return false;
  if (method === "notify") return typeof value.message === "string";
  if (method === "setStatus") return typeof value.statusKey === "string";
  if (method === "setWidget") return typeof value.widgetKey === "string";
  if (method === "setTitle") return typeof value.title === "string";
  if (method === "set_editor_text") return typeof value.text === "string";
  if (method === "confirm" || method === "input" || method === "editor") return typeof value.title === "string";
  if (method === "select") return typeof value.title === "string" && Array.isArray(value.options);
  return false;
}

export function isSessionCardData(value: unknown): value is SessionCardData {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.cwd === "string"
    && typeof value.status === "string"
    && typeof value.lastActivity === "number";
}

// ---------- small string / path helpers ----------

export function basename(value: string): string {
  return value.split("/").filter(Boolean).at(-1) ?? value;
}

export function truncate(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

export function resolveForkSelection(messages: readonly BranchMessageOption[], input: string): BranchMessageOption | undefined {
  const maybeIndex = Number(input);
  if (Number.isInteger(maybeIndex) && maybeIndex >= 1 && maybeIndex <= messages.length) return messages[maybeIndex - 1];
  return messages.find((message) => message.entryId === input || message.entryId.startsWith(input));
}

export function readSessionFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get("session");
}

/**
 * Returns true if `candidate` is the same as or a subdirectory of `root`.
 * String-comparison only — we don't have node's path.resolve / relative
 * in the browser, but both inputs come from the server which already
 * resolved them, so a normalised prefix check is sufficient.
 */
export function isWithin(candidate: string, root: string): boolean {
  if (!candidate || !root) return false;
  const c = candidate.replace(/\/+$/, "");
  const r = root.replace(/\/+$/, "");
  return c === r || c.startsWith(`${r}/`);
}

// ---------- 'Recent' sort: last-user-activity persistence ----------
//
// We persist the per-session 'last user activity' timestamps in localStorage
// so a reload or new tab preserves the same sidebar order the user
// established. Failures (no localStorage, quota errors, parse errors) all
// degrade silently to an empty map.
export const USER_ACTIVITY_STORAGE_KEY = "pi-crust:lastUserActivityById:v1";

export function recentSortKey(session: SessionCardData, optimisticUserActivityById: Record<string, number>): number {
  if (typeof session.lastUserActivity === "number" && Number.isFinite(session.lastUserActivity)) {
    return session.lastUserActivity;
  }
  const optimistic = optimisticUserActivityById[session.id];
  if (typeof optimistic === "number" && Number.isFinite(optimistic)) return optimistic;
  if (typeof session.createdAt === "number" && Number.isFinite(session.createdAt)) return session.createdAt;
  return session.lastActivity;
}

export function loadUserActivityMap(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(USER_ACTIVITY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveUserActivityMap(map: Record<string, number>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(USER_ACTIVITY_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota / private-mode failures are not worth surfacing.
  }
}

// ---------- formatting ----------

export function formatExtensionCommandResult(result: unknown, title: string): string {
  if (typeof result === "string" && result.trim()) return result;
  if (typeof result === "number" || typeof result === "boolean") return String(result);
  if (result && typeof result === "object") return `${title}: ${JSON.stringify(result)}`;
  return `${title} completed.`;
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function formatStats(
  stats: SessionCardStats | undefined,
  tokenSummary: string | undefined,
): string {
  if (!stats) return tokenSummary ?? "0 tokens";
  const parts = [
    `↑${compactNumber(stats.inputTokens)}`,
    `↓${compactNumber(stats.outputTokens)}`,
    `r${compactNumber(stats.cacheReadTokens)}`,
    `w${compactNumber(stats.cacheWriteTokens)}`,
    `$${stats.cost.toFixed(4)}`,
  ];
  const contextPercent = formatPercent(stats.contextPercent);
  if (contextPercent) parts.push(contextPercent);
  if (stats.contextWindow !== null) parts.push(compactNumber(stats.contextWindow));
  return parts.join(" ");
}

export function formatPercent(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const percent = Math.max(0, Math.min(100, value));
  if (percent > 0 && percent < 1) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

export function compactNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function shortSessionId(id: string): string {
  const compact = id.replace(/-/g, "");
  return compact.length > 8 ? compact.slice(0, 8) : compact;
}

export function toPromptAttachment(
  attachment: { type: "image" | "file"; name: string; mimeType?: string; data?: string },
): PromptAttachment {
  return {
    type: attachment.type,
    name: attachment.name,
    ...optional({ mimeType: attachment.mimeType }),
    ...optional({ data: attachment.data }),
  };
}

// ---------- session-status snapshot merge + polling ----------

export function mergeSessionStatusSnapshot(
  current: readonly SessionCardData[],
  snapshot: readonly SessionCardData[],
): readonly SessionCardData[] {
  const byId = new Map(snapshot.map((session) => [session.id, session]));
  const seen = new Set<string>();
  const merged = current.map((session) => {
    const next = byId.get(session.id);
    if (!next) return session;
    seen.add(session.id);
    return {
      ...session,
      status: next.status,
      cwd: next.cwd,
      ...optional({ sessionName: next.sessionName }),
      ...optional({ model: next.model }),
      ...optional({ tokenSummary: next.tokenSummary }),
      ...optional({ stats: next.stats }),
      ...optional({ createdAt: next.createdAt }),
      ...optional({ lastUserActivity: next.lastUserActivity }),
      // Status polling should update the row's live state and server-authored
      // lastUserActivity, but observing a session is not activity. Preserve
      // lastActivity so assistant/tool/status churn does not move rows.
      lastActivity: session.lastActivity,
    };
  });
  for (const session of snapshot) {
    if (!seen.has(session.id)) merged.push(session);
  }
  return merged;
}

export function sessionStatusPollIntervalMs(): number {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return 15_000;
  return 4_000;
}
