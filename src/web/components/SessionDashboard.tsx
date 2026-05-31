import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ExtensionUiRequest, ExtensionUiResponse, WireMessage } from "../../shared/protocol.js";
import type { PiDynamicCommandInfo } from "../../shared/slash-command-routing.js";
import type { BranchCloneResult, BranchForkResult, BranchMessageOption, DashboardArtifact, DashboardMessage, DashboardToolDetails, ExtensionRegistryInfo, ExtensionSettingsResponse, SessionCardData, SessionDashboardApi } from "../api/session-api.js";
import { MAX_PROMPT_CHARS } from "../../shared/limits.js";
import { isRecord, errorMessage, optional } from "../../shared/util.js";
import { sanitizePiDynamicCommands } from "../../shared/slash-command-routing.js";

/** How many recent messages to fetch on initial session-open. Older history
 *  is paginated on scroll. Sized to comfortably cover a typical viewport
 *  plus some scroll-back without dragging the whole transcript over the
 *  network for long sessions (e.g. the autotime-series-2 session whose full
 *  /messages payload was ~28 MB before this limit was applied). */
const INITIAL_MESSAGES_LIMIT = 200;
const DASHBOARD_ERROR_TOAST_ID = "dashboard-error";

function isTransientPromptTransportError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return normalized === "load failed"
    || normalized === "failed to fetch"
    || normalized.includes("networkerror")
    || normalized.includes("network error")
    || normalized.includes("network request failed")
    || normalized.includes("the network connection was lost")
    || normalized.includes("cancelled")
    || normalized.includes("canceled")
    || normalized.includes("aborted");
}

import { MessageTimeline, type TimelineMessage } from "./MessageTimeline.js";
import { SessionTerminal } from "./SessionTerminal.js";
import { SessionContentErrorBoundary } from "./SessionContentErrorBoundary.js";
import { ModelPicker } from "./ModelPicker.js";
import { LoginDialog, type LoginDialogApi } from "./LoginDialog.js";
import { LogoutDialog, type LogoutDialogApi } from "./LogoutDialog.js";

const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING = "Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage.";
import { PromptComposer, type ComposerAttachment } from "./PromptComposer.js";
import { ShortcutHelp } from "./ShortcutHelp.js";
import { ExtensionUiHost } from "./ExtensionUiHost.js";
import { ExternalWebActivity } from "../extensions/external-web-module.js";
import type { WebActivityContribution } from "../extensions/types.js";
import { ExtensionManagementPanel } from "./ExtensionManagementPanel.js";
import { NotificationsProvider, useNotifications } from "./notifications.js";
import "./session-dashboard.css";
import { Icon } from "./Icon.js";
import { AppBrand, isPlainLeftClick, updateFavicon, imageFaviconDataUrl } from "./app-brand.js";
import {
  basename,
  compactNumber,
  contentText,
  contentTextAndThinking,
  extractArtifact,
  formatExtensionCommandResult,
  formatPercent,
  formatStats,
  isExtensionUiRequest,
  isSessionCardData,
  isWithin,
  loadUserActivityMap,
  mergeSessionStatusSnapshot,
  readSessionFromUrl,
  recentSortKey,
  resolveForkSelection,
  saveUserActivityMap,
  sessionStatusPollIntervalMs,
  shortSessionId,
  toolResultText,
  toPromptAttachment as toPromptAttachmentImpl,
  truncate,
  unique,
  upsertExtensionUiRequest,
} from "./session-dashboard-helpers.js";
import { applyRealtimeEvent, toTimelineMessage } from "./session-dashboard-realtime.js";

// Re-export so the existing test import path keeps working without an update.
export { imageFaviconDataUrl };

type DashboardView = "sessions" | "settings" | "terminal" | `activity:${string}`;

export interface SessionDashboardProps {
  readonly api: SessionDashboardApi;
}

type SortMode = "recent" | "name" | "cwd";

export function SessionDashboard(props: SessionDashboardProps) {
  return (
    <NotificationsProvider>
      <SessionDashboardInner {...props} />
    </NotificationsProvider>
  );
}

function SessionDashboardInner({ api }: SessionDashboardProps) {
  const { notify, dismiss } = useNotifications();
  // Adapters for the legacy setError / setNotice call sites. The general
  // dashboard error uses a stable toast id so repeated poll/reload failures
  // (notably mobile Safari's terse "Load failed") replace the existing toast
  // instead of stacking a screenful of identical notifications. Passing `null`
  // clears the current dashboard error early on the next successful refresh.
  const lastErrorIdRef = useRef<string | null>(null);
  const setError = useCallback((message: string | null) => {
    if (message === null) {
      if (lastErrorIdRef.current) {
        dismiss(lastErrorIdRef.current);
        lastErrorIdRef.current = null;
      }
      return;
    }
    lastErrorIdRef.current = DASHBOARD_ERROR_TOAST_ID;
    notify({ id: DASHBOARD_ERROR_TOAST_ID, kind: "error", message });
  }, [notify, dismiss]);
  const setNotice = useCallback((message: string | null) => {
    if (message === null) return;
    notify({ kind: "info", message });
  }, [notify]);
  const [sessions, setSessions] = useState<readonly SessionCardData[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => readSessionFromUrl());
  // Active workspace tab for the current session: chat timeline vs. terminal.
  const [defaultCwd, setDefaultCwd] = useState("");
  // Path-policy allowed project root, surfaced via /api/health. Used to
  // decide whether $HOME is a safe default for new sessions or whether
  // we should fall back to the API server's own cwd.
  const [projectRoot, setProjectRoot] = useState("");
  const [appName, setAppName] = useState("π crust");
  const [appIcon, setAppIcon] = useState<string | undefined>(undefined);
  const [backendGitSha, setBackendGitSha] = useState<string | undefined>(undefined);
  // The user's home directory (server-side). Preferred as the New Session
  // dialog default; falls back to defaultCwd when the API doesn't expose it.
  const [homeCwd, setHomeCwd] = useState<string>("");
  const [query, setQuery] = useState("");
  const [showPaths, setShowPaths] = useState(false);
  const [namedOnly, setNamedOnly] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  // Sidebar 'Recent' sort key. We track the last time the *user* drove
  // activity into a session (prompt sent, bash command sent, session
  // created/forked/cloned) on this client, and sort by that. Server-side
  // ticks — LLM streaming, tool executions, status polls, session-index
  // mtime drift — are deliberately ignored so the row doesn't move out
  // from under the user just because the agent is doing work. Persisted
  // to localStorage so a reload preserves the order the user established.
  const [lastUserActivityById, setLastUserActivityById] = useState<Record<string, number>>(() => loadUserActivityMap());
  const userActivityMapHydrated = useRef(false);
  useEffect(() => {
    if (!userActivityMapHydrated.current) {
      userActivityMapHydrated.current = true;
      return;
    }
    saveUserActivityMap(lastUserActivityById);
  }, [lastUserActivityById]);
  const bumpUserActivity = useCallback((sessionId: string, when: number = Date.now()) => {
    setLastUserActivityById((current) => ({ ...current, [sessionId]: when }));
  }, []);
  const [messagesBySession, setMessagesBySession] = useState<Record<string, TimelineMessage[]>>({});
  // Pagination state for the on-demand "load older messages" flow. The
  // initial transcript fetch is capped to INITIAL_MESSAGES_LIMIT, so for
  // any session longer than that we set hasMoreOlder=true and let the
  // MessageTimeline trigger paginate-on-scroll-up via loadOlderMessages.
  const [hasMoreOlderBySession, setHasMoreOlderBySession] = useState<Record<string, boolean>>({});
  const [loadingOlderBySession, setLoadingOlderBySession] = useState<Record<string, boolean>>({});
  const [steeringBySession, setSteeringBySession] = useState<Record<string, string[]>>({});
  const [followUpBySession, setFollowUpBySession] = useState<Record<string, string[]>>({});
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [loginDialog, setLoginDialog] = useState<{ open: boolean; provider?: string }>({ open: false });
  const [logoutDialogOpen, setLogoutDialogOpen] = useState(false);
  const [extensions, setExtensions] = useState<ExtensionRegistryInfo>({ commands: [], activities: [], routes: [], diagnostics: [] });
  const [extensionSettings, setExtensionSettings] = useState<ExtensionSettingsResponse | null>(null);
  const [piCommandsBySession, setPiCommandsBySession] = useState<Record<string, readonly PiDynamicCommandInfo[]>>({});
  const [connectionStatusBySession, setConnectionStatusBySession] = useState<Record<string, string | undefined>>({});

  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(max-width: 720px)").matches;
  });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [view, setView] = useState<DashboardView>("sessions");
  const [creatingSessionFromMenu, setCreatingSessionFromMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);
  // Per-session prompt error helper. Surfaces as a red toast keyed by the
  // session id so re-submitting on the same session replaces in place,
  // and clearing the error (success path) dismisses the toast.
  const setPromptError = useCallback((sessionId: string, message: string | null) => {
    const toastId = `prompt-error-${sessionId}`;
    if (message === null) { dismiss(toastId); return; }
    notify({ id: toastId, kind: "error", message: `Prompt failed. ${message}` });
  }, [notify, dismiss]);
  const setConnectionStatus = useCallback((sessionId: string, message: string | null) => {
    setConnectionStatusBySession((current) => {
      if (message === null) {
        if (current[sessionId] === undefined) return current;
        const next = { ...current };
        delete next[sessionId];
        return next;
      }
      if (current[sessionId] === message) return current;
      return { ...current, [sessionId]: message };
    });
  }, []);
  const [extensionUiBySession, setExtensionUiBySession] = useState<Record<string, ExtensionUiRequest[]>>({});
  const [forkDialogOpen, setForkDialogOpen] = useState(false);
  const [forkMessages, setForkMessages] = useState<readonly BranchMessageOption[]>([]);
  const [forkBusy, setForkBusy] = useState(false);
  const [forkError, setForkError] = useState<string | null>(null);
  const [draftSeedBySession, setDraftSeedBySession] = useState<Record<string, { readonly id: string; readonly value: string }>>({});
  const streamDraftIdsRef = useRef<Record<string, string>>({});

  const refreshExtensions = useCallback(async () => {
    if (!api.getExtensions) return;
    const extensionInfo = await api.getExtensions();
    setExtensions(extensionInfo);
  }, [api]);

  const refreshExtensionSettings = useCallback(async () => {
    if (!api.getExtensionSettings) return;
    const settings = await api.getExtensionSettings();
    setExtensionSettings(settings);
    setExtensions(settings.extensions);
  }, [api]);

  const refreshPiCommands = useCallback(async (sessionId: string, options: { readonly notifyOnError?: boolean } = {}) => {
    if (!api.getPiCommands) return;
    try {
      const commands = sanitizePiDynamicCommands(await api.getPiCommands(sessionId));
      setPiCommandsBySession((current) => ({ ...current, [sessionId]: commands }));
    } catch (caught) {
      setPiCommandsBySession((current) => ({ ...current, [sessionId]: [] }));
      if (options.notifyOnError) setNotice(`Could not load Pi dynamic commands: ${errorMessage(caught)}`);
    }
  }, [api]);

  const reloadExtensions = useCallback(async () => {
    // The ExtensionManagementPanel's `run()` helper surfaces a success
    // toast (and inline error) on its own. We only need to update local
    // state here and re-throw so the panel sees the failure.
    if (api.reloadExtensions) {
      const result = await api.reloadExtensions();
      setExtensions(result.extensions);
      if (api.getExtensionSettings) void refreshExtensionSettings();
      if (!result.applied) throw new Error("Extension reload failed; previous extensions are still active.");
    } else {
      await refreshExtensions();
    }
  }, [api, refreshExtensions, refreshExtensionSettings]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 720px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Auto-close the sidebar drawer on mobile whenever the active session changes.
  useEffect(() => {
    if (isMobile && activeSessionId) setSidebarOpen(false);
  }, [isMobile, activeSessionId]);

  useEffect(() => {
    if (!filtersOpen) return;
    function onDown(event: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(event.target as Node)) {
        setFiltersOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [filtersOpen]);

  useEffect(() => {
    // Browser tab title mirrors the app name. The pre-rename special case
    // (where the bare default "pi remote" expanded to "pi remote control")
    // is gone now that the default is already the full brand name.
    document.title = appName;
    updateFavicon(appIcon);
  }, [appName, appIcon]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (api.getExtensions) {
          try {
            await refreshExtensions();
          } catch {
            // Optional capability; ignore older API servers.
          }
        }
        if (api.getExtensionSettings) {
          try {
            await refreshExtensionSettings();
          } catch {
            // Optional capability; ignore older API servers.
          }
        }
        const defaultCwd = api.getDefaultCwd ? await api.getDefaultCwd() : "/tmp/project";
        if (cancelled) return;
        setDefaultCwd(defaultCwd);
        if (api.getServerInfo) {
          try {
            const info = await api.getServerInfo();
            if (!cancelled) {
              setProjectRoot(info.projectRoot ?? "");
              setAppName(info.appName || "π crust");
              setAppIcon(info.appIcon);
              setBackendGitSha(info.gitSha);
            }
          } catch {
            // Optional capability; ignore.
          }
        }
        if (api.getHomeCwd) {
          try {
            const home = await api.getHomeCwd();
            if (!cancelled && home) setHomeCwd(home);
          } catch {
            // Optional capability; ignore.
          }
        }
        const initialSessions = await api.listSessions(defaultCwd);
        if (cancelled) return;
        setSessions(initialSessions);
        // Seed the user-activity map for sessions we haven't seen before so
        // the very first render after install/reload has a reasonable order.
        // Sessions that already have an entry (from localStorage) keep it.
        setLastUserActivityById((current) => {
          let next: Record<string, number> | null = null;
          for (const session of initialSessions) {
            if (current[session.id] === undefined) {
              if (!next) next = { ...current };
              next[session.id] = session.lastActivity;
            }
          }
          return next ?? current;
        });
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      }
    })();
    return () => { cancelled = true; };
  }, [api, refreshExtensions, refreshExtensionSettings]);

  useEffect(() => {
    if (!api.listSessionStatuses || !defaultCwd) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const statuses = await api.listSessionStatuses?.(defaultCwd);
        if (!cancelled && statuses) {
          setSessions((current) => mergeSessionStatusSnapshot(current, statuses));
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      } finally {
        if (!cancelled) timer = setTimeout(poll, sessionStatusPollIntervalMs());
      }
    };

    timer = setTimeout(poll, 0);
    const onVisibilityChange = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(poll, 0);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [api, defaultCwd]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (activeSessionId) url.searchParams.set("session", activeSessionId);
    else url.searchParams.delete("session");
    const next = url.toString();
    if (next !== window.location.href) window.history.replaceState(null, "", next);
  }, [activeSessionId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    function handler() {
      setActiveSessionId(readSessionFromUrl());
    }
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  useEffect(() => {
    if (!activeSessionId) return;
    let cancelled = false;
    let pendingRefresh: ReturnType<typeof setTimeout> | undefined;

    const applyRefreshedSession = (refreshed: import("../api/session-api.js").SessionCardData, options: { readonly preserveLastActivity?: boolean }) => {
      setSessions((current) => current.map((session) => {
        if (session.id !== refreshed.id) return session;
        return {
          ...session,
          status: refreshed.status,
          ...optional({ model: refreshed.model }),
          ...optional({ tokenSummary: refreshed.tokenSummary }),
          ...optional({ stats: refreshed.stats }),
          ...optional({ createdAt: refreshed.createdAt }),
          ...optional({ lastUserActivity: refreshed.lastUserActivity }),
          lastActivity: options.preserveLastActivity ? session.lastActivity : refreshed.lastActivity,
        };
      }));
    };

    // Initial mount: pull the full transcript once. After this point we rely
    // on the SSE event stream (applyRealtimeEvent below) for incremental
    // message updates so we don't re-fetch the entire jsonl every time the
    // agent sends a message_end / agent_end event.
    const refreshAll = async (options: { readonly preserveLastActivity?: boolean } = {}) => {
      try {
        // Bound the initial transcript fetch to the most recent
        // INITIAL_MESSAGES_LIMIT entries so opening a multi-MB session
        // doesn't slurp + JSON.parse the whole jsonl on the server (which
        // would block the Node event loop for tens of seconds and starve
        // every other request) and doesn't ship tens of MB of JSON over
        // the wire to be reparsed in the browser. Older history is loaded
        // on demand when the user scrolls up; new activity is appended via
        // the SSE event stream (applyRealtimeEvent).
        const [messages, refreshed] = await Promise.all([
          api.getMessages(activeSessionId, { limit: INITIAL_MESSAGES_LIMIT }),
          api.getSession ? api.getSession(activeSessionId) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        const timelineMessages = messages.map(toTimelineMessage);
        setMessagesBySession((current) => ({ ...current, [activeSessionId]: timelineMessages }));
        // If we hit the limit, more (older) messages probably exist; arm
        // the load-older affordance. Falls back to false otherwise so we
        // don't show the loader on short transcripts.
        setHasMoreOlderBySession((current) => ({
          ...current,
          [activeSessionId]: messages.length >= INITIAL_MESSAGES_LIMIT,
        }));
        if (refreshed) applyRefreshedSession(refreshed, options);
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      }
    };

    // Lightweight metadata-only refresh: updates the session card (status,
    // token usage, lastActivity) but does NOT re-fetch the message timeline.
    // The historical implementation always called api.getMessages here as a
    // belt-and-braces resync, which ballooned to ~57 s / 29 MB on long
    // image-heavy transcripts. Live message updates come from SSE.
    const refreshSessionMeta = async () => {
      if (!api.getSession) return;
      try {
        const refreshed = await api.getSession(activeSessionId);
        if (cancelled || !refreshed) return;
        applyRefreshedSession(refreshed, {});
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      }
    };

    const scheduleRefresh = () => {
      if (cancelled) return;
      if (pendingRefresh) clearTimeout(pendingRefresh);
      pendingRefresh = setTimeout(() => {
        pendingRefresh = undefined;
        void refreshSessionMeta();
      }, 80);
    };

    const applyStreamEvent = (event: unknown) => {
      if (cancelled || !isRecord(event) || typeof event.type !== "string") return;
      setConnectionStatus(activeSessionId, null);
      if (event.type === "extension_ui_request" && isExtensionUiRequest(event)) {
        setExtensionUiBySession((current) => ({
          ...current,
          [activeSessionId]: upsertExtensionUiRequest(current[activeSessionId] ?? [], event),
        }));
        return;
      }
      if (applyRealtimeEvent(activeSessionId, event, setMessagesBySession, streamDraftIdsRef.current)) {
        return;
      }
      if (event.type === "agent_start") {
        setSessions((current) => current.map((session) => session.id === activeSessionId ? { ...session, status: "streaming" } : session));
        return;
      }
      if (event.type === "agent_end") {
        delete streamDraftIdsRef.current[activeSessionId];
        setSessions((current) => current.map((session) => session.id === activeSessionId ? { ...session, status: "idle" } : session));
        scheduleRefresh();
        return;
      }
      if (event.type === "message_end" || event.type === "tool_execution_end") {
        scheduleRefresh();
        return;
      }
      if (event.type === "stream_reconnected") {
        // The SSE was re-established after a mobile-tab background suspend.
        // Server-side events that fired while we were disconnected are gone
        // — do a full refetch so the transcript catches up. Without this
        // the UI shows whatever frame was last received before suspend
        // (e.g. a stale "idle" header) even though new messages exist.
        void refreshAll({ preserveLastActivity: true });
        return;
      }
    };

    // Selecting a session often requires opening and hydrating it, but that is
    // only a view action. Keep its existing sort timestamp so the row does not
    // jump out from under the pointer just because it was clicked. Real agent
    // activity still updates the timestamp through scheduled refreshes below.
    void refreshAll({ preserveLastActivity: true });
    const unsubscribe = api.streamEvents ? api.streamEvents(activeSessionId, applyStreamEvent) : () => undefined;

    return () => {
      cancelled = true;
      if (pendingRefresh) clearTimeout(pendingRefresh);
      unsubscribe();
    };
  }, [activeSessionId, api]);

  const visibleSessions = useMemo(() => {
    const lowered = query.toLowerCase();
    const filtered = sessions.filter((session) => {
      if (namedOnly && !session.sessionName) return false;
      const haystack = [session.sessionName, session.cwd, session.id, session.model].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(lowered);
    });
    return [...filtered].sort((a, b) => {
      if (sortMode === "name") return (a.sessionName ?? a.id).localeCompare(b.sessionName ?? b.id);
      if (sortMode === "cwd") return a.cwd.localeCompare(b.cwd);
      // 'Recent' is defined as the last time the user authored input in
      // the session. Prefer the server-computed session-history timestamp
      // so prompts sent from another tab/API still reorder correctly. The
      // client map is only an optimistic/back-compat fallback when the
      // server does not expose lastUserActivity yet.
      const recentDelta = recentSortKey(b, lastUserActivityById) - recentSortKey(a, lastUserActivityById);
      if (recentDelta !== 0) return recentDelta;
      const createdDelta = (b.createdAt ?? 0) - (a.createdAt ?? 0);
      if (createdDelta !== 0) return createdDelta;
      return (a.sessionName ?? a.id).localeCompare(b.sessionName ?? b.id);
    });
  }, [namedOnly, query, sessions, sortMode, lastUserActivityById]);

  const activeSession = activeSessionId ? sessions.find((session) => session.id === activeSessionId) : null;
  const openSessionFromExtension = useCallback(async (sessionId: string) => {
    setView("sessions");
    setActiveSessionId(sessionId);
    try {
      const refreshed = await api.listSessions(defaultCwd);
      let merged: readonly SessionCardData[] = refreshed;
      if (!refreshed.some((session) => session.id === sessionId) && api.getSession) {
        try {
          const spawned = await api.getSession(sessionId);
          merged = [spawned, ...refreshed];
        } catch {
          // Keep the active id; the session may become listable shortly.
        }
      }
      setSessions(merged);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [api, defaultCwd]);
  const webActivities = useMemo<WebActivityContribution[]>(() => [
    ...extensions.activities.map((activity): WebActivityContribution => ({
      id: activity.id,
      title: activity.title,
      ...optional({ order: activity.order }),
      extensionId: activity.extensionId,
      render: () => activity.webModuleUrl
        ? <ExternalWebActivity activity={activity} extensions={extensions} api={api} navigation={{ openSession: openSessionFromExtension }} />
        : <ExtensionActivityPanel activity={activity} extensions={extensions} />,
    })),
  ].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title)), [api, extensions, openSessionFromExtension]);
  const extensionSlashCommands = useMemo(
    () => extensions.commands.map((command) => command.slashName).filter((slashName): slashName is string => Boolean(slashName)),
    [extensions.commands],
  );
  const hasExtensionSlashCommand = useCallback((name: string) => extensions.commands.some((command) => command.slashName === name), [extensions.commands]);

  // Fetch a page of older messages for the given session and prepend them
  // to the in-memory timeline. Wired to MessageTimeline's onLoadOlder so
  // scrolling near the top of a long transcript transparently pulls more
  // history. Uses `before:` = oldest currently-loaded timestamp as the
  // cursor and de-dupes by message id so re-fires (e.g. rapid scroll
  // gestures, React StrictMode double-invocation) are safe.
  const loadOlderMessages = useCallback(async (sessionId: string) => {
    const existing = messagesBySession[sessionId];
    if (!existing || existing.length === 0) return;
    if (loadingOlderBySession[sessionId]) return;
    if (hasMoreOlderBySession[sessionId] === false) return;
    // The oldest currently-rendered timestamp becomes our `before:` cursor.
    // Messages without a timestamp are skipped for the purposes of finding
    // a cursor; if none of the loaded messages have a timestamp we can't
    // page further (the server tail-read needs a numeric boundary).
    let oldestTs: number | undefined;
    for (const m of existing) {
      if (typeof m.timestamp === "number" && (oldestTs === undefined || m.timestamp < oldestTs)) {
        oldestTs = m.timestamp;
      }
    }
    if (oldestTs === undefined) {
      setHasMoreOlderBySession((current) => ({ ...current, [sessionId]: false }));
      return;
    }
    setLoadingOlderBySession((current) => ({ ...current, [sessionId]: true }));
    try {
      const older = await api.getMessages(sessionId, { limit: INITIAL_MESSAGES_LIMIT, before: oldestTs });
      const olderTimeline = older.map(toTimelineMessage);
      setMessagesBySession((current) => {
        const present = current[sessionId] ?? [];
        const known = new Set(present.map((m) => m.id));
        const fresh = olderTimeline.filter((m) => !known.has(m.id));
        if (fresh.length === 0) return current;
        return { ...current, [sessionId]: [...fresh, ...present] };
      });
      // If the server returned fewer than we asked for we've reached the
      // start of the transcript — stop triggering future fetches.
      setHasMoreOlderBySession((current) => ({
        ...current,
        [sessionId]: older.length >= INITIAL_MESSAGES_LIMIT,
      }));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoadingOlderBySession((current) => ({ ...current, [sessionId]: false }));
    }
  }, [api, messagesBySession, hasMoreOlderBySession, loadingOlderBySession]);
  const activePiCommands = activeSessionId ? (piCommandsBySession[activeSessionId] ?? []) : [];
  useEffect(() => {
    if (!activeSessionId || !api.getPiCommands) return;
    void refreshPiCommands(activeSessionId);
  }, [activeSessionId, api.getPiCommands, refreshPiCommands]);
  const commandSuggestions = useMemo(
    () => unique([
      "login", "logout", "model", "settings", "session", "compact", "reload", "new", "clear",
      ...extensionSlashCommands,
      ...activePiCommands.map((command) => command.name),
    ]),
    [activePiCommands, extensionSlashCommands],
  );
  const activeActivity = view.startsWith("activity:")
    ? webActivities.find((activity) => activity.id === view.slice("activity:".length))
    : undefined;
  const enabledArtifactMimes = useMemo(() => {
    const mimes = ["application/vnd.vega-lite.v5+json", "image/*", "text/html", "text/markdown"];
    if (extensions.routes.some((route) => route.path === "/api/sessions/:sessionId/presentations/:file")) {
      mimes.push("application/vnd.pi.presentation+json");
    }
    return mimes;
  }, [extensions.routes]);

  async function createSession(input?: { readonly cwd?: string; readonly sessionName?: string }) {
    setError(null);
    // Prefer the user's $HOME when it's still inside the path-policy's
    // allowed projectRoot (the common production case where projectRoot
    // is $HOME). In tighter sandboxes (CI / playwright runs where
    // projectRoot is the repo root) homeCwd falls outside policy, so
    // fall back to defaultCwd — the API server's own cwd, which is
    // always within projectRoot by construction. The explicit input
    // override (e.g. from a slash command) trumps both.
    const inferredHomeCwd = homeCwd && projectRoot && isWithin(homeCwd, projectRoot) ? homeCwd : "";
    const nextCwd = input?.cwd?.trim() || inferredHomeCwd || defaultCwd;
    const nextName = input?.sessionName?.trim() ?? "";
    const created = await api.createSession({ cwd: nextCwd, ...(nextName ? { sessionName: nextName } : {}) });
    setSessions((current) => [created, ...current]);
    bumpUserActivity(created.id);
    setMessagesBySession((current) => ({ ...current, [created.id]: [] }));
    setActiveSessionId(created.id);
    // Trigger PromptComposer's draftSeed effect to focus the textarea on
    // freshly created sessions — the inline 'New session' flow expects to
    // act like "the prompt is the new-session dialog".
    setDraftSeedBySession((current) => ({
      ...current,
      [created.id]: { id: `created-${created.id}-${Date.now()}`, value: "" },
    }));
    return created;
  }

  async function createSessionFromMenu() {
    if (creatingSessionFromMenu) return;
    setView("sessions");
    setCreatingSessionFromMenu(true);
    try {
      await createSession();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setCreatingSessionFromMenu(false);
    }
  }

  function beginRename() {
    if (!activeSession) return;
    setDeletePending(false);
    setRenaming(true);
  }

  function cancelRename() {
    setRenaming(false);
  }

  async function commitRename(name: string) {
    if (!activeSession) return;
    const next = name.trim();
    setRenaming(false);
    if (!next || next === (activeSession.sessionName ?? "")) return;
    const captured = activeSession;
    await api.renameSession(captured.id, next);
    setSessions((current) => current.map((session) => session.id === captured.id ? { ...session, sessionName: next } : session));
  }

  function beginDelete() {
    if (!activeSession) return;
    setRenaming(false);
    setDeletePending(true);
  }

  function cancelDelete() {
    setDeletePending(false);
  }

  async function confirmDelete() {
    if (!activeSession) return;
    setDeletePending(false);
    await api.deleteSession(activeSession.id);
    setSessions((current) => current.filter((session) => session.id !== activeSession.id));
    setMessagesBySession((current) => {
      const next = { ...current };
      delete next[activeSession.id];
      return next;
    });
    setActiveSessionId(null);
  }

  function appendMessage(sessionId: string, message: TimelineMessage) {
    setMessagesBySession((current) => ({
      ...current,
      [sessionId]: [...(current[sessionId] ?? []), message],
    }));
  }

  async function handlePrompt(text: string, attachments: readonly ComposerAttachment[]) {
    if (!activeSession) return;
    const sessionId = activeSession.id;
    const now = Date.now();
    // Submitting a prompt is the canonical 'user activity' signal for
    // sorting. Bump synchronously (not after the await) so the sidebar
    // reorders immediately on click, not when the network round-trip
    // resolves.
    bumpUserActivity(sessionId, now);
    if (text.length > MAX_PROMPT_CHARS) {
      setPromptError(sessionId, `Message is ${text.length.toLocaleString()} characters. The limit is ${MAX_PROMPT_CHARS.toLocaleString()}. Use the paperclip (or paste an image) instead of pasting image data as text.`);
      return;
    }
    setPromptError(sessionId, null);
    appendMessage(sessionId, {
      id: `user-pending-${now}`,
      role: "user",
      text,
      images: attachments.filter((attachment) => attachment.previewUrl).map((attachment) => ({
        id: attachment.id,
        src: attachment.previewUrl!,
        alt: attachment.name,
      })),
    });
    setSessions((current) => current.map((session) => session.id === sessionId ? { ...session, status: "streaming", lastUserActivity: now } : session));
    try {
      const messages = await api.prompt(sessionId, text, attachments.map(toPromptAttachment));
      setConnectionStatus(sessionId, null);
      if (Array.isArray(messages) && messages.length > 0) {
        setMessagesBySession((current) => ({ ...current, [sessionId]: messages.map(toTimelineMessage) }));
      }
    } catch (caught) {
      const message = errorMessage(caught);
      if (isTransientPromptTransportError(message)) {
        setPromptError(sessionId, null);
        setConnectionStatus(sessionId, "Reconnecting…");
      } else {
        setConnectionStatus(sessionId, null);
        setPromptError(sessionId, message);
      }
    } finally {
      setSessions((current) => current.map((session) => session.id === sessionId ? { ...session, status: "idle" } : session));
    }
  }

  function handleSteer(text: string) {
    if (!activeSession) return;
    setSteeringBySession((current) => ({ ...current, [activeSession.id]: [...(current[activeSession.id] ?? []), text] }));
  }

  function handleFollowUp(text: string) {
    if (!activeSession) return;
    setFollowUpBySession((current) => ({ ...current, [activeSession.id]: [...(current[activeSession.id] ?? []), text] }));
  }

  // Auto-drain queued follow-ups whenever the active session is idle. The
  // composer routes Send-while-streaming into onFollowUp, so without this
  // effect the queued text never actually fires — it just sits in the
  // "Follow-up: …" chip forever.
  //
  // Re-entry is prevented by two synchronously-batched state updates:
  //   (1) the optimistic shift below removes the head from the queue, and
  //   (2) handlePrompt synchronously sets status="streaming" at the top.
  // So the next render this effect sees either a shorter queue or a
  // non-idle session and bails. On the following idle the effect picks up
  // the next queued item.
  useEffect(() => {
    if (!activeSession) return;
    if (activeSession.status !== "idle") return;
    const queue = followUpBySession[activeSession.id] ?? [];
    if (queue.length === 0) return;
    const [head, ...rest] = queue;
    if (typeof head !== "string") return;
    setFollowUpBySession((current) => ({ ...current, [activeSession.id]: rest }));
    void handlePrompt(head, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.id, activeSession?.status, followUpBySession]);

  async function openForkDialog(argv = "") {
    if (!activeSession) return;
    if (!api.request) {
      setNotice("The branching extension is not available.");
      return;
    }
    setForkBusy(true);
    setForkError(null);
    setForkDialogOpen(true);
    try {
      const messages = await requestForkMessages(api, activeSession.id);
      setForkMessages(messages);
      const target = argv.trim();
      if (target) {
        const selected = resolveForkSelection(messages, target);
        if (!selected) {
          setForkError(`No fork message matches "${target}".`);
          return;
        }
        await forkFromMessage(selected.entryId);
      }
    } catch (caught) {
      setForkError(errorMessage(caught));
    } finally {
      setForkBusy(false);
    }
  }

  async function forkFromMessage(entryId: string) {
    if (!activeSession || !api.request) return;
    setForkBusy(true);
    setForkError(null);
    try {
      const result = await requestForkSession(api, activeSession.id, entryId);
      if (result.cancelled) {
        setNotice("Fork cancelled by extension.");
        return;
      }
      const session = result.session;
      setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
      bumpUserActivity(session.id);
      setMessagesBySession((current) => ({ ...current, [session.id]: [] }));
      if (result.text) {
        setDraftSeedBySession((current) => ({ ...current, [session.id]: { id: `${Date.now()}-${entryId}`, value: result.text ?? "" } }));
      }
      setActiveSessionId(session.id);
      setForkDialogOpen(false);
      setNotice(result.text ? "Forked session. The selected prompt is ready to edit." : "Forked session.");
    } catch (caught) {
      setForkError(errorMessage(caught));
    } finally {
      setForkBusy(false);
    }
  }

  async function cloneActiveSession() {
    if (!activeSession) return;
    if (!api.request) {
      setNotice("The branching extension is not available.");
      return;
    }
    try {
      const result = await requestCloneSession(api, activeSession.id);
      if (result.cancelled) {
        setNotice("Clone cancelled by extension.");
        return;
      }
      const session = result.session;
      openBranchedSession(session, undefined, "Cloned session.");
    } catch (caught) {
      setNotice(errorMessage(caught));
    }
  }

  function openBranchedSession(session: SessionCardData, draftText?: string, noticeText?: string) {
    setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
    bumpUserActivity(session.id);
    setMessagesBySession((current) => ({ ...current, [session.id]: [] }));
    if (draftText) {
      setDraftSeedBySession((current) => ({ ...current, [session.id]: { id: `${Date.now()}-${session.id}`, value: draftText } }));
    }
    setActiveSessionId(session.id);
    if (noticeText) setNotice(noticeText);
  }

  async function handleExtensionCommandResult(result: unknown, title: string) {
    if (!isRecord(result) || typeof result.prcAction !== "string") {
      setNotice(formatExtensionCommandResult(result, title));
      return;
    }
    if (result.prcAction === "openForkDialog") {
      await openForkDialog();
      return;
    }
    if (result.prcAction === "openSession") {
      if (!isSessionCardData(result.session)) throw new Error("Extension command returned an invalid session");
      openBranchedSession(result.session, typeof result.draftText === "string" ? result.draftText : undefined, typeof result.notice === "string" ? result.notice : undefined);
      return;
    }
    if (result.prcAction === "notice") {
      setNotice(typeof result.notice === "string" ? result.notice : formatExtensionCommandResult(result, title));
      return;
    }
    setNotice(formatExtensionCommandResult(result, title));
  }

  async function handleSlashCommand(name: string, argv: string, original?: string) {
    if (name === "login") {
      await loginFromSlash(argv);
      return;
    }
    if (name === "logout") {
      await logoutFromSlash(argv);
      return;
    }
    if (!activeSession) {
      setNotice("Open or create a session first to run slash commands.");
      return;
    }
    switch (name) {
      case "model":
      case "models":
        setModelPickerOpen(true);
        return;
      case "session":
      case "info":
        setNotice(`Session ${activeSession.id} — model ${activeSession.model ?? "unset"} — ${activeSession.tokenSummary ?? ""}`);
        return;
      case "compact":
        await compactActiveSession(argv);
        return;
      case "reload":
        await reloadActiveSession();
        return;
      case "new":
      case "clear":
        // /clear was renamed to /new in pi (see pi-coding-agent CHANGELOG:
        // "Renamed n to /new ... Hook event reasons before_clear/clear are
        // now before_new/new"). Keep /clear working as an alias for muscle
        // memory from other coding agents (Claude Code etc.).
        await createSession();
        return;
      case "name":
        if (!argv.trim()) {
          setNotice("Usage: /name <session name>");
          return;
        }
        await api.renameSession(activeSession.id, argv.trim());
        setSessions((current) => current.map((session) => session.id === activeSession.id ? { ...session, sessionName: argv.trim() } : session));
        return;
      case "quit":
      case "close":
        beginDelete();
        return;
      case "help":
      case "hotkeys":
        setNotice(`Available: ${commandSuggestions.map((command) => `/${command}`).join(", ")}, /name <name>, /quit, /help`);
        return;
      default: {
        const extensionCommand = extensions.commands.find((command) => command.slashName === name);
        if (extensionCommand && api.runExtensionCommand) {
          try {
            const response = await api.runExtensionCommand(extensionCommand.extensionId, extensionCommand.invocationName, {
              argv,
              sessionId: activeSession.id,
              cwd: activeSession.cwd,
            }) as { result?: unknown } | undefined;
            await handleExtensionCommandResult(response?.result, extensionCommand.title);
          } catch (caught) {
            setNotice(errorMessage(caught));
          }
          return;
        }
        const piDynamicCommand = activePiCommands.find((command) => command.name === name);
        if (piDynamicCommand && api.runPiSlashCommand) {
          try {
            await api.runPiSlashCommand(activeSession.id, original ?? `/${name}${argv ? ` ${argv}` : ""}`);
            void refreshPiCommands(activeSession.id, { notifyOnError: true });
          } catch (caught) {
            setNotice(errorMessage(caught));
          }
          return;
        }
        setNotice(`Unknown slash command \"/${name}\". It was not found in pi-crust built-ins, web extensions, Pi extension commands, skills, or prompt templates.`);
      }
    }
  }

  async function loginFromSlash(argv: string): Promise<void> {
    if (!api.login) {
      setNotice("This server does not support login. Run /login in the Pi TUI.");
      return;
    }
    const [provider, ...keyParts] = argv.trim().split(/\s+/).filter(Boolean);
    const apiKey = keyParts.join(" ").trim();
    // `/login <provider> <api-key>` stays a one-shot for muscle memory and
    // scripting. Everything else opens the interactive dialog, which mirrors
    // the TUI's auth-type -> provider -> (OAuth | API key) flow.
    if (provider && apiKey) {
      try {
        const result = await api.login(provider, apiKey);
        setNotice(`Saved API key for ${result.provider.name ?? result.provider.provider}.`);
        if (api.getExtensionSettings) void refreshExtensionSettings();
      } catch (caught) {
        setNotice(errorMessage(caught));
      }
      return;
    }
    const supportsOAuth = !!(api.startOAuthLogin && api.pollOAuthLogin && api.submitOAuthLogin && api.cancelOAuthLogin && api.listAuthProviders);
    if (!supportsOAuth) {
      setView("settings");
      setNotice("Usage: /login <provider> <api-key>. This server does not support interactive login; run /login in the Pi TUI for subscription OAuth.");
      return;
    }
    setLoginDialog({ open: true, ...(provider ? { provider } : {}) });
  }

  async function logoutFromSlash(argv: string): Promise<void> {
    if (!api.logout) {
      setNotice("This server does not support logout. Run /logout in the Pi TUI.");
      return;
    }
    const provider = argv.trim().split(/\s+/)[0] ?? "";
    // `/logout <provider>` stays a one-shot for scripting; bare `/logout`
    // opens the interactive provider selector, mirroring the TUI.
    if (!provider) {
      if (api.listAuthProviders) {
        setLogoutDialogOpen(true);
        return;
      }
      setView("settings");
      setNotice("Usage: /logout <provider>.");
      return;
    }
    try {
      // Capture the credential type before logout so we can phrase the result
      // the same way the TUI does (subscription vs. stored API key).
      let priorType: "oauth" | "api_key" | undefined;
      let displayName = provider;
      if (api.listAuthProviders) {
        const before = (await api.listAuthProviders()).providers.find((entry) => entry.provider === provider);
        priorType = before?.credentialType;
        displayName = before?.name ?? provider;
      }
      await api.logout(provider);
      const message = priorType === "api_key"
        ? `Removed stored API key for ${displayName}. Environment variables and models.json config are unchanged.`
        : `Logged out of ${displayName}.`;
      setNotice(message);
      if (api.getExtensionSettings) void refreshExtensionSettings();
    } catch (caught) {
      setNotice(errorMessage(caught));
    }
  }

  async function reloadActiveSession(): Promise<void> {
    if (!activeSession) return;
    if (!api.reloadSession) {
      setNotice("This session adapter does not support reload.");
      return;
    }
    const sessionId = activeSession.id;
    try {
      setNotice("Reloading Pi RPC session…");
      const reloaded = await api.reloadSession(sessionId);
      setSessions((current) => current.map((session) => session.id === sessionId ? reloaded : session));
      setActiveSessionId(reloaded.id);
      void refreshPiCommands(reloaded.id, { notifyOnError: true });
      setNotice("Reloaded Pi RPC session.");
    } catch (caught) {
      setNotice(errorMessage(caught));
    }
  }

  async function compactActiveSession(customInstructions: string): Promise<void> {
    if (!activeSession) return;
    if (!api.compact) {
      setNotice("This session adapter does not support compaction.");
      return;
    }
    const sessionId = activeSession.id;
    const now = Date.now();
    bumpUserActivity(sessionId, now);
    setPromptError(sessionId, null);
    setNotice(customInstructions.trim() ? "Compacting conversation with custom instructions…" : "Compacting conversation…");
    setSessions((current) => current.map((session) => session.id === sessionId
      ? { ...session, status: "compacting", lastUserActivity: now }
      : session));
    try {
      const messages = await api.compact(sessionId, customInstructions.trim() || undefined);
      setConnectionStatus(sessionId, null);
      if (Array.isArray(messages)) {
        setMessagesBySession((current) => ({ ...current, [sessionId]: messages.map(toTimelineMessage) }));
      }
      setNotice("Compaction complete.");
    } catch (caught) {
      setConnectionStatus(sessionId, null);
      setNotice(errorMessage(caught));
    } finally {
      setSessions((current) => current.map((session) => session.id === sessionId ? { ...session, status: "idle" } : session));
    }
  }

  async function respondToExtensionUi(response: ExtensionUiResponse): Promise<void> {
    if (!activeSession || !api.respondToExtensionUi) {
      setNotice("This session adapter does not support extension UI responses.");
      return;
    }
    const sessionId = activeSession.id;
    try {
      await api.respondToExtensionUi(sessionId, response);
      setExtensionUiBySession((current) => ({
        ...current,
        [sessionId]: (current[sessionId] ?? []).filter((request) => request.id !== response.id),
      }));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function handleBash(command: string, includeInContext: boolean) {
    if (!activeSession) return;
    const sessionId = activeSession.id;
    const now = Date.now();
    bumpUserActivity(sessionId, now);
    setPromptError(sessionId, null);
    appendMessage(sessionId, {
      id: `bash-${now}`,
      role: "custom",
      customLabel: includeInContext ? "Shell command" : "Hidden shell command",
      text: `$ ${command}\nSending to Pi...`,
    });
    setSessions((current) => current.map((session) => session.id === sessionId ? { ...session, lastUserActivity: now } : session));
    try {
      const messages = await api.bash(sessionId, command, includeInContext);
      setConnectionStatus(sessionId, null);
      setMessagesBySession((current) => ({ ...current, [sessionId]: messages.map(toTimelineMessage) }));
    } catch (caught) {
      const message = errorMessage(caught);
      if (isTransientPromptTransportError(message)) {
        setPromptError(sessionId, null);
        setConnectionStatus(sessionId, "Reconnecting…");
      } else {
        setConnectionStatus(sessionId, null);
        setPromptError(sessionId, message);
      }
    }
  }

  return (
    <main className={`session-dashboard ${sidebarOpen ? "" : "collapsed"} ${isMobile ? "is-mobile" : ""}`}>
      {sidebarOpen && isMobile ? (
        <div
          className="sidebar-backdrop"
          aria-hidden="true"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}
      {sidebarOpen ? null : (
        <button
          type="button"
          className="sidebar-toggle sidebar-toggle--floating"
          aria-label="Expand sidebar"
          aria-pressed={false}
          onClick={() => setSidebarOpen(true)}
        >
          <SidebarToggleGlyph />
        </button>
      )}

      <aside className="session-sidebar" aria-label="Sessions" aria-hidden={!sidebarOpen}>
        <header>
          <AppBrand
            appName={appName}
            {...(appIcon ? { appIcon } : {})}
            onNavigateRoot={() => { setActiveSessionId(null); setView("sessions"); }}
          />
          <button
            type="button"
            className="sidebar-toggle"
            aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            aria-pressed={sidebarOpen}
            onClick={() => setSidebarOpen((open) => !open)}
          >
            <SidebarToggleGlyph />
          </button>
        </header>

        <nav aria-label="Workspace" className="sidebar-menu">
          {creatingSessionFromMenu ? (
            <button
              type="button"
              className="sidebar-menu-item loading"
              aria-busy={true}
              aria-label="Creating session"
              disabled={true}
            >
              <LoadingEllipsisIcon />
              <span>
                Creating<span className="loading-ellipsis" aria-hidden="true">...</span>
              </span>
            </button>
          ) : (
            <a
              href="/"
              className="sidebar-menu-item"
              aria-label="New session"
              onClick={(event) => {
                if (!isPlainLeftClick(event)) return;
                event.preventDefault();
                void createSessionFromMenu();
              }}
            >
              <NewSessionGlyph />
              New session
            </a>
          )}
          {webActivities.map((activity) => {
            const activityView = `activity:${activity.id}` as DashboardView;
            const isActive = view === activityView;
            return (
              <a
                key={activity.id}
                href="/"
                className={`sidebar-menu-item ${isActive ? "active" : ""}`}
                aria-pressed={isActive}
                onClick={(event) => {
                  if (!isPlainLeftClick(event)) return;
                  event.preventDefault();
                  setView(isActive ? "sessions" : activityView);
                }}
              >
                {activity.id === "core.schedule.activity" || activity.extensionId === "core.schedule" || activity.extensionId === "@cemoody/pi-crust-ext-schedule" ? <CronGlyph /> : <ExtensionGlyph />}
                {activity.title}
              </a>
            );
          })}
          <a
            href="/"
            className={`sidebar-menu-item ${view === "terminal" ? "active" : ""}`}
            data-testid="sidebar-terminal"
            aria-label="Terminal"
            aria-pressed={view === "terminal"}
            onClick={(event) => {
              if (!isPlainLeftClick(event)) return;
              event.preventDefault();
              setView(view === "terminal" ? "sessions" : "terminal");
            }}
          >
            <TerminalGlyph />
            Terminal
          </a>
          {api.getExtensionSettings || api.setExtensionEnabled || api.installExtensionPackage || api.reloadExtensions ? (
            <a
              href="/"
              className={`sidebar-menu-item ${view === "settings" ? "active" : ""}`}
              aria-pressed={view === "settings"}
              onClick={(event) => {
                if (!isPlainLeftClick(event)) return;
                event.preventDefault();
                setView(view === "settings" ? "sessions" : "settings");
              }}
            >
              <ExtensionGlyph />
              Settings
            </a>
          ) : null}
        </nav>

        <section aria-label="Session browser controls" className="session-controls">
          <div className="session-search" ref={filterRef}>
            <input placeholder="Search sessions" value={query} onChange={(event) => setQuery(event.target.value)} />
            <button
              type="button"
              className={`session-filter-toggle ${filtersOpen ? "open" : ""}`}
              aria-label="Filter sessions"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((open) => !open)}
            >
              <FilterGlyph />
            </button>
            {filtersOpen ? (
              <div className="session-filter-popover" role="menu" aria-label="Session filters">
                <label className="popover-row">
                  <span>Sort by</span>
                  <select aria-label="Sort sessions" value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
                    <option value="recent">Recent</option>
                    <option value="name">Name</option>
                    <option value="cwd">CWD</option>
                  </select>
                </label>
                <label className="popover-row checkbox-row">
                  <input type="checkbox" checked={showPaths} onChange={(event) => setShowPaths(event.target.checked)} />
                  <span>Show paths</span>
                </label>
                <label className="popover-row checkbox-row">
                  <input type="checkbox" checked={namedOnly} onChange={(event) => setNamedOnly(event.target.checked)} />
                  <span>Named only</span>
                </label>
              </div>
            ) : null}
          </div>
        </section>

        <ul className="session-list">
          {visibleSessions.map((session) => (
            <li key={session.id}>
              <a
                href={`?session=${encodeURIComponent(session.id)}`}
                className={session.id === activeSessionId ? "active" : ""}
                onClick={(event) => {
                  if (!isPlainLeftClick(event)) return;
                  event.preventDefault();
                  setActiveSessionId(session.id);
                  setView("sessions");
                }}
              >
                <span
                  className={`session-row-dot ${session.status === "streaming" ? "streaming" : ""}`}
                  aria-hidden="true"
                />
                <span className="session-row-name">{session.sessionName ?? "Untitled session"}</span>
                {session.status && session.status !== "idle" && session.status !== "streaming" ? (
                  <span className="session-row-status">{session.status}</span>
                ) : null}
                <span className="session-row-id">
                  {showPaths ? <span>{session.cwd}</span> : <span>{basename(session.cwd)}</span>}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </aside>

      <section className="active-session" aria-label={view === "settings" ? "Settings" : view === "terminal" ? "Terminal" : activeActivity ? activeActivity.title : "Active session"}>
        {view === "terminal" ? (
          (() => {
            const terminalSession = activeSession ?? sessions[0] ?? null;
            return (
              <>
                <header>
                  <div className="active-title">
                    <h2>Terminal</h2>
                    {terminalSession ? (
                      <span className="active-subtitle"><code>{terminalSession.cwd ?? shortSessionId(terminalSession.id)}</code></span>
                    ) : null}
                  </div>
                </header>
                {terminalSession ? (
                  <SessionContentErrorBoundary resetKey={`${terminalSession.id}:terminal`}>
                    <SessionTerminal sessionId={terminalSession.id} active />
                  </SessionContentErrorBoundary>
                ) : (
                  <div className="terminal-empty" role="status">
                    Select or create a session to open a terminal in its working directory.
                  </div>
                )}
              </>
            );
          })()
        ) : view === "settings" ? (
          <ExtensionManagementPanel
            extensions={extensions}
            settings={extensionSettings}
            currentAppName={appName}
            {...(appIcon ? { currentAppIcon: appIcon } : {})}
            api={api}
            onReload={reloadExtensions}
            onNotice={setNotice}
            {...(api.setAppBranding ? { onSaveBranding: async (branding) => {
              const result = await api.setAppBranding!(branding);
              setAppName(result.appName || "π crust");
              setAppIcon(result.appIcon);
              if (api.getExtensionSettings) await refreshExtensionSettings();
            } } : {})}
            {...(api.setExtensionEnabled ? { onToggle: async (extensionId: string, enabled: boolean) => {
              const result = await api.setExtensionEnabled!(extensionId, enabled);
              setExtensions(result.extensions);
              if (api.getExtensionSettings) await refreshExtensionSettings();
            } } : {})}
            {...(api.installExtensionPackage ? { onInstall: async (source: string) => {
              const result = await api.installExtensionPackage!(source);
              setExtensions(result.extensions);
              if (api.getExtensionSettings) await refreshExtensionSettings();
            } } : {})}
            {...(api.removeExtensionPackage ? { onRemove: async (source: string) => {
              const result = await api.removeExtensionPackage!(source);
              setExtensions(result.extensions);
              if (api.getExtensionSettings) await refreshExtensionSettings();
            } } : {})}
            {...(api.setSetting ? { onSaveSetting: async (key: string, value: unknown) => {
              const result = await api.setSetting!(key, value);
              setExtensions(result.extensions);
              if (api.getExtensionSettings) await refreshExtensionSettings();
            } } : {})}
          />
        ) : activeActivity ? (
          activeActivity.render()
        ) : activeSession ? (
          <>
            <header>
              {renaming ? (
                <RenameSessionForm
                  initialName={activeSession.sessionName ?? ""}
                  onSave={(name) => void commitRename(name)}
                  onCancel={cancelRename}
                />
              ) : deletePending ? (
                <div className="inline-confirm" role="alertdialog" aria-label="Delete session">
                  <span>Delete <strong>{activeSession.sessionName ?? activeSession.id}</strong>?</span>
                  <button type="button" className="danger" onClick={() => void confirmDelete()}>Confirm delete</button>
                  <button type="button" onClick={cancelDelete}>Cancel</button>
                </div>
              ) : (
                <>
                  <div className="active-title">
                    <h2>{activeSession.sessionName ?? "Untitled session"}</h2>
                    <span className="active-subtitle"><code>{shortSessionId(activeSession.id)}</code></span>
                  </div>
                  <div className="active-actions">
                    {hasExtensionSlashCommand("fork") ? (
                      <button type="button" className="action-icon" aria-label="Fork" title="Fork session from a previous message" onClick={() => void handleSlashCommand("fork", "")}>
                        <ForkGlyph />
                      </button>
                    ) : null}
                    {hasExtensionSlashCommand("clone") ? (
                      <button type="button" className="action-icon" aria-label="Clone" title="Clone session" onClick={() => void handleSlashCommand("clone", "")}>
                        <CloneGlyph />
                      </button>
                    ) : null}
                    <span className="active-actions-sep" aria-hidden="true" />
                    <button type="button" className="action-icon" aria-label="Rename" title="Rename session" onClick={beginRename}>
                      <PencilGlyph />
                    </button>
                    <button type="button" className="action-icon ghost-danger" aria-label="Delete" title="Delete session" onClick={beginDelete}>
                      <TrashGlyph />
                    </button>
                  </div>
                </>
              )}
            </header>

            <div className="active-session-workspace">
              <SessionContentErrorBoundary resetKey={activeSession.id}>
                <MessageTimeline
                  messages={messagesBySession[activeSession.id] ?? []}
                  streaming={activeSession.status === "streaming"}
                  enabledArtifactMimes={enabledArtifactMimes}
                  sessionId={activeSession.id}
                  hasMoreOlder={hasMoreOlderBySession[activeSession.id] ?? false}
                  loadingOlder={loadingOlderBySession[activeSession.id] ?? false}
                  onLoadOlder={() => { void loadOlderMessages(activeSession.id); }}
                />
              </SessionContentErrorBoundary>
              <ExtensionUiHost
                requests={extensionUiBySession[activeSession.id] ?? []}
                onValueResponse={(id, value) => respondToExtensionUi({ id, value })}
                onConfirmResponse={(id, confirmed) => respondToExtensionUi({ id, confirmed })}
                onCancelResponse={(id) => respondToExtensionUi({ id, cancelled: true })}
                onNotify={(request) => notify({
                  id: `ext-notify-${request.id}`,
                  kind: request.notifyType === "error" ? "error" : request.notifyType === "warning" ? "warning" : "info",
                  message: request.message,
                })}
              />
              {(messagesBySession[activeSession.id]?.length ?? 0) === 0 ? (
                <InlineNameInput
                  sessionId={activeSession.id}
                  currentName={activeSession.sessionName ?? ""}
                  onCommit={(next) => void commitRename(next)}
                />
              ) : null}

              <PromptComposer
                sessionId={activeSession.id}
                isStreaming={activeSession.status === "streaming"}
                steeringQueue={steeringBySession[activeSession.id] ?? []}
                followUpQueue={followUpBySession[activeSession.id] ?? []}
                fileSuggestions={["README.md", "package.json", "src/web/main.tsx", "src/server/session/session-registry.ts"]}
                commandSuggestions={commandSuggestions}
                statusText={activeSession.status}
                {...optional({ connectionStatusText: connectionStatusBySession[activeSession.id] })}
                statusCwd={activeSession.cwd}
                {...optional({ statusModel: activeSession.model })}
                statusTokens={formatStats(activeSession.stats, activeSession.tokenSummary)}
                onPrompt={handlePrompt}
                onSteer={handleSteer}
                onFollowUp={handleFollowUp}
                onAbort={() => activeSession ? api.abort(activeSession.id) : undefined}
                onBash={handleBash}
                onAbortBash={() => undefined}
                {...optional({ draftSeed: draftSeedBySession[activeSession.id] })}
                onSlashCommand={handleSlashCommand}
              />
            </div>
          </>
        ) : (
          <p>Select or create a session.</p>
        )}
      </section>



      {forkDialogOpen ? (
        <div className="new-session-backdrop" role="presentation" onClick={() => setForkDialogOpen(false)}>
          <section
            className="new-session-dialog fork-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Fork session"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <h2>Fork session</h2>
              <button type="button" onClick={() => setForkDialogOpen(false)} aria-label="Close fork dialog">×</button>
            </header>
            <p className="dialog-help">Choose a previous user message. Pi Remote Control will create a new session and restore that prompt into the composer so you can edit it.</p>
            {forkError ? <p role="alert" className="dialog-error">{forkError}</p> : null}
            {forkBusy ? <p role="status">Loading fork points…</p> : null}
            {!forkBusy && forkMessages.length === 0 ? <p>No user messages are available to fork yet.</p> : null}
            {forkMessages.length > 0 ? (
              <ol className="fork-message-list" aria-label="Fork points">
                {forkMessages.map((message, index) => (
                  <li key={message.entryId}>
                    <button type="button" onClick={() => void forkFromMessage(message.entryId)} disabled={forkBusy}>
                      <span className="fork-message-index">{index + 1}</span>
                      <span className="fork-message-text">{truncate(message.text, 180)}</span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : null}
            <footer>
              <button type="button" onClick={() => setForkDialogOpen(false)}>Cancel</button>
            </footer>
          </section>
        </div>
      ) : null}

      <ShortcutHelp {...(backendGitSha ? { backendInfo: { gitSha: backendGitSha } } : {})} />

      {api.startOAuthLogin && api.pollOAuthLogin && api.submitOAuthLogin && api.cancelOAuthLogin && api.listAuthProviders && api.login ? (
        <LoginDialog
          open={loginDialog.open}
          api={api as unknown as LoginDialogApi}
          {...(loginDialog.provider ? { initialProvider: loginDialog.provider } : {})}
          onClose={() => setLoginDialog({ open: false })}
          onLoggedIn={(provider, authType, message) => {
            // Mirror the TUI's one-time Anthropic subscription billing warning.
            const warn = provider === "anthropic" && authType === "oauth";
            setNotice(warn ? `${message} ${ANTHROPIC_SUBSCRIPTION_AUTH_WARNING}` : message);
            if (api.getExtensionSettings) void refreshExtensionSettings();
          }}
        />
      ) : null}
      {api.listAuthProviders && api.logout ? (
        <LogoutDialog
          open={logoutDialogOpen}
          api={api as unknown as LogoutDialogApi}
          onClose={() => setLogoutDialogOpen(false)}
          onLoggedOut={(_provider, message) => {
            setNotice(message);
            if (api.getExtensionSettings) void refreshExtensionSettings();
          }}
        />
      ) : null}
      <ModelPicker
        open={modelPickerOpen}
        loadModels={async () => (api.listModels ? api.listModels() : [])}
        onSelect={async (provider, modelId) => {
          if (!activeSession || !api.setModel) return;
          const updated = await api.setModel(activeSession.id, provider, modelId);
          setSessions((current) => current.map((session) => session.id === updated.id ? updated : session));
        }}
        onClose={() => setModelPickerOpen(false)}
      />
    </main>
  );
}

/**
 * Inline 'name this session' input that lives above the prompt composer
 * while the active session still has zero messages. Owns its own local
 * state so keystrokes don't bubble up to SessionDashboard re-renders
 * (and therefore don't churn the MessageTimeline). Commits on blur.
 */
function InlineNameInput(props: {
  readonly sessionId: string;
  readonly currentName: string;
  readonly onCommit: (name: string) => void;
}) {
  const [draft, setDraft] = useState("");
  // Reset draft when switching sessions — we don't want a half-typed
  // name to leak from one fresh session to another.
  useEffect(() => { setDraft(""); }, [props.sessionId]);
  const inputId = `session-name-${props.sessionId}`;
  return (
    <div className="session-name-row">
      {/* Clicking anywhere in the row (including the icon) focuses the
          input — the icon is decorative; the <label htmlFor> handles the
          actual focus delegation. */}
      <label htmlFor={inputId} className="session-name-icon" aria-hidden="true">
        <PencilGlyph />
      </label>
      <input
        id={inputId}
        type="text"
        className="session-name-input"
        placeholder={props.currentName || "Optionally name this session…"}
        aria-label="Name this session"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (!next || next === props.currentName) return;
          props.onCommit(next);
        }}
      />
    </div>
  );
}

function RenameSessionForm(props: {
  readonly initialName: string;
  readonly onSave: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(props.initialName);

  return (
    <div className="inline-rename" role="group" aria-label="Rename session">
      <input
        autoFocus
        aria-label="Session name"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            props.onSave(draft);
          } else if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel();
          }
        }}
      />
      <button type="button" className="primary" onClick={() => props.onSave(draft)}>Save</button>
      <button type="button" onClick={props.onCancel}>Cancel</button>
    </div>
  );
}

function NewSessionDialog(props: {
  readonly initialCwd: string;
  readonly onCreate: (input: { readonly cwd: string; readonly sessionName?: string }) => Promise<void> | void;
  readonly onCancel: () => void;
}) {
  const [cwd, setCwd] = useState(props.initialCwd);
  const [sessionName, setSessionName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const cwdRef = useRef<HTMLInputElement | null>(null);

  // Position the caret at the start of the CWD field exactly ONCE on mount,
  // so the path's leading characters are visible on narrow phones. The
  // previous implementation did this in an inline `ref` callback that React
  // re-invokes on every render — which meant every keystroke (and every SSE
  // event that re-rendered the dashboard) jumped the caret back to column 0.
  useEffect(() => {
    const node = cwdRef.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(0, 0);
    node.scrollLeft = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    if (submitting) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const name = sessionName.trim();
      await props.onCreate({ cwd: cwd.trim(), ...(name ? { sessionName: name } : {}) });
      // On success the parent unmounts the dialog. If it doesn't (e.g.
      // because onCreate is sync), drop the spinner so the form is usable.
      setSubmitting(false);
    } catch (caught) {
      setSubmitting(false);
      setSubmitError(errorMessage(caught));
    }
  }

  function handleCancel() {
    if (submitting) return; // don't let users back out mid-creation
    props.onCancel();
  }

  return (
    <div className="new-session-backdrop" role="presentation" onClick={handleCancel}>
      <form
        className="new-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Create new session"
        aria-busy={submitting}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header>
          <div className="new-session-title">
            <h2>New session</h2>
            <p>Spawn a fresh pi agent in a working directory.</p>
          </div>
          <button type="button" onClick={handleCancel} aria-label="Close new session dialog" disabled={submitting}>×</button>
        </header>
        <div className="new-session-fields">
          <label>
            <span className="field-label">Working directory</span>
            <input
              ref={cwdRef}
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              aria-label="New session cwd"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              disabled={submitting}
            />
            <span className="field-hint">Defaults to your home directory.</span>
          </label>
          <label>
            <span className="field-label">
              Name
              <span className="field-tag">optional</span>
            </span>
            <input
              value={sessionName}
              onChange={(event) => setSessionName(event.target.value)}
              aria-label="New session name"
              placeholder="Untitled session"
              spellCheck={false}
              disabled={submitting}
            />
          </label>
          {submitError ? <p className="new-session-error" role="alert">{submitError}</p> : null}
        </div>
        <footer>
          <button type="button" onClick={handleCancel} disabled={submitting}>Cancel</button>
          <button type="submit" className="primary" disabled={submitting || !cwd.trim()} aria-label={submitting ? "Creating session" : "Create session"}>
            {submitting ? (
              <>
                <span className="button-spinner" aria-hidden="true" />
                <span>Creating…</span>
              </>
            ) : "Create session"}
          </button>
        </footer>
      </form>
    </div>
  );
}

async function requestForkMessages(api: SessionDashboardApi, sessionId: string): Promise<readonly BranchMessageOption[]> {
  if (!api.request) throw new Error("The branching extension is not available.");
  return api.request<readonly BranchMessageOption[]>(`/api/sessions/${encodeURIComponent(sessionId)}/fork-messages`);
}

async function requestForkSession(api: SessionDashboardApi, sessionId: string, entryId: string): Promise<BranchForkResult> {
  if (!api.request) throw new Error("The branching extension is not available.");
  return api.request<BranchForkResult>(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, { method: "POST", body: { entryId } });
}

async function requestCloneSession(api: SessionDashboardApi, sessionId: string): Promise<BranchCloneResult> {
  if (!api.request) throw new Error("The branching extension is not available.");
  return api.request<BranchCloneResult>(`/api/sessions/${encodeURIComponent(sessionId)}/clone`, { method: "POST", body: {} });
}

function toPromptAttachment(attachment: ComposerAttachment): import("../api/session-api.js").PromptAttachment {
  return toPromptAttachmentImpl(attachment);
}

function ExtensionActivityPanel({ activity, extensions }: { readonly activity: import("../api/session-api.js").ExtensionActivityInfo; readonly extensions: ExtensionRegistryInfo }) {
  const commands = extensions.commands.filter((command) => command.extensionId === activity.extensionId);
  const routes = extensions.routes.filter((route) => route.extensionId === activity.extensionId);
  return (
    <div className="extension-activity-panel">
      <header>
        <div className="active-title">
          <h2>{activity.title}</h2>
          <span className="active-subtitle"><code>{activity.extensionId}</code></span>
        </div>
      </header>
      <div className="extension-activity-body">
        <p>This activity was contributed by a pi-crust extension. Custom web rendering will be enabled as the extension framework matures.</p>
        {commands.length > 0 ? (
          <section>
            <h3>Commands</h3>
            <ul>
              {commands.map((command) => (
                <li key={command.invocationName}>
                  <strong>{command.title}</strong>{command.slashName ? <span> — <code>/{command.slashName}</code></span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {routes.length > 0 ? (
          <section>
            <h3>Server routes</h3>
            <ul>
              {routes.map((route) => <li key={`${route.method}:${route.path}`}><code>{route.method} /api/extensions/{route.extensionId}{route.path}</code></li>)}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function FilterGlyph() { return <Icon name="filter" />; }
function ForkGlyph() { return <Icon name="fork" />; }
function CloneGlyph() { return <Icon name="clone" />; }
function PencilGlyph() { return <Icon name="pencil" />; }
function TrashGlyph() { return <Icon name="trash" />; }
function SidebarToggleGlyph() { return <Icon name="sidebar-toggle" />; }
function NewSessionGlyph() { return <Icon name="new-session" />; }
function CronGlyph() { return <Icon name="cron" />; }
function ExtensionGlyph() { return <Icon name="extension" />; }
function TerminalGlyph() { return <Icon name="terminal" />; }

function LoadingEllipsisIcon() {
  return (
    <span className="loading-ellipsis-icon" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}


