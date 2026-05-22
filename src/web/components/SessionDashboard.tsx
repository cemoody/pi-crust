import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ExtensionUiRequest, ExtensionUiResponse, WireMessage } from "../../shared/protocol.js";
import type { BranchCloneResult, BranchForkResult, BranchMessageOption, DashboardArtifact, DashboardMessage, DashboardToolDetails, ExtensionRegistryInfo, ExtensionSettingsResponse, SessionCardData, SessionDashboardApi } from "../api/session-api.js";
import { MAX_PROMPT_CHARS } from "../../shared/limits.js";

/** How many recent messages to fetch on initial session-open. Older history
 *  is paginated on scroll. Sized to comfortably cover a typical viewport
 *  plus some scroll-back without dragging the whole transcript over the
 *  network for long sessions (e.g. the autotime-series-2 session whose full
 *  /messages payload was ~28 MB before this limit was applied). */
const INITIAL_MESSAGES_LIMIT = 200;
import { MessageTimeline, type TimelineMessage } from "./MessageTimeline.js";
import { ModelPicker } from "./ModelPicker.js";
import { PromptComposer, type ComposerAttachment } from "./PromptComposer.js";
import { ShortcutHelp } from "./ShortcutHelp.js";
import { ExtensionUiHost } from "./ExtensionUiHost.js";
import { ExternalWebActivity } from "../extensions/external-web-module.js";
import type { WebActivityContribution } from "../extensions/types.js";
import { ExtensionManagementPanel } from "./ExtensionManagementPanel.js";
import "./session-dashboard.css";

type DashboardView = "sessions" | "settings" | `activity:${string}`;

export interface SessionDashboardProps {
  readonly api: SessionDashboardApi;
}

type SortMode = "recent" | "name" | "cwd";

export function SessionDashboard({ api }: SessionDashboardProps) {
  const [sessions, setSessions] = useState<readonly SessionCardData[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => readSessionFromUrl());
  const [defaultCwd, setDefaultCwd] = useState("");
  // Path-policy allowed project root, surfaced via /api/health. Used to
  // decide whether $HOME is a safe default for new sessions or whether
  // we should fall back to the API server's own cwd.
  const [projectRoot, setProjectRoot] = useState("");
  const [appName, setAppName] = useState("pi remote");
  const [appIcon, setAppIcon] = useState<string | undefined>(undefined);
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
  const [error, setError] = useState<string | null>(null);
  const [messagesBySession, setMessagesBySession] = useState<Record<string, TimelineMessage[]>>({});
  const [steeringBySession, setSteeringBySession] = useState<Record<string, string[]>>({});
  const [followUpBySession, setFollowUpBySession] = useState<Record<string, string[]>>({});
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [extensions, setExtensions] = useState<ExtensionRegistryInfo>({ commands: [], activities: [], routes: [], diagnostics: [] });
  const [extensionSettings, setExtensionSettings] = useState<ExtensionSettingsResponse | null>(null);

  const [notice, setNotice] = useState<string | null>(null);
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
  const [promptErrorBySession, setPromptErrorBySession] = useState<Record<string, string | null>>({});
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

  const reloadExtensions = useCallback(async () => {
    try {
      if (api.reloadExtensions) {
        const result = await api.reloadExtensions();
        setExtensions(result.extensions);
        if (api.getExtensionSettings) void refreshExtensionSettings();
        setNotice(result.applied ? "Extensions reloaded." : "Extension reload failed; previous extensions are still active.");
      } else {
        await refreshExtensions();
        setNotice("Extensions refreshed.");
      }
    } catch (caught) {
      setError(errorMessage(caught));
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
    document.title = appName === "pi remote" ? "pi remote control" : appName;
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
              setAppName(info.appName || "pi remote");
              setAppIcon(info.appIcon);
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
          ...(refreshed.model === undefined ? {} : { model: refreshed.model }),
          ...(refreshed.tokenSummary === undefined ? {} : { tokenSummary: refreshed.tokenSummary }),
          ...(refreshed.stats === undefined ? {} : { stats: refreshed.stats }),
          ...(refreshed.createdAt === undefined ? {} : { createdAt: refreshed.createdAt }),
          ...(refreshed.lastUserActivity === undefined ? {} : { lastUserActivity: refreshed.lastUserActivity }),
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
        setMessagesBySession((current) => ({ ...current, [activeSessionId]: messages.map(toTimelineMessage) }));
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
      ...(activity.order === undefined ? {} : { order: activity.order }),
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
  const commandSuggestions = useMemo(
    () => unique([
      "model", "settings", "session", "new", "clear",
      ...extensionSlashCommands,
    ]),
    [extensionSlashCommands],
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
      setPromptErrorBySession((current) => ({
        ...current,
        [sessionId]: `Message is ${text.length.toLocaleString()} characters. The limit is ${MAX_PROMPT_CHARS.toLocaleString()}. Use the paperclip (or paste an image) instead of pasting image data as text.`,
      }));
      return;
    }
    setPromptErrorBySession((current) => ({ ...current, [sessionId]: null }));
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
      if (Array.isArray(messages) && messages.length > 0) {
        setMessagesBySession((current) => ({ ...current, [sessionId]: messages.map(toTimelineMessage) }));
      }
    } catch (caught) {
      setPromptErrorBySession((current) => ({ ...current, [sessionId]: errorMessage(caught) }));
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

  async function handleSlashCommand(name: string, argv: string) {
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
        setNotice(`Command \"/${name}\" is recognised in the TUI but not yet implemented in the WUI.`);
      }
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
    setPromptErrorBySession((current) => ({ ...current, [sessionId]: null }));
    appendMessage(sessionId, {
      id: `bash-${now}`,
      role: "custom",
      customLabel: includeInContext ? "Shell command" : "Hidden shell command",
      text: `$ ${command}\nSending to Pi...`,
    });
    setSessions((current) => current.map((session) => session.id === sessionId ? { ...session, lastUserActivity: now } : session));
    try {
      const messages = await api.bash(sessionId, command, includeInContext);
      setMessagesBySession((current) => ({ ...current, [sessionId]: messages.map(toTimelineMessage) }));
    } catch (caught) {
      setPromptErrorBySession((current) => ({ ...current, [sessionId]: errorMessage(caught) }));
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
                {activity.extensionId === "core.schedule" ? <CronGlyph /> : <ExtensionGlyph />}
                {activity.title}
              </a>
            );
          })}
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

        {error ? <p role="alert">{error}</p> : null}

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

      <section className="active-session" aria-label={view === "settings" ? "Settings" : activeActivity ? activeActivity.title : "Active session"}>
        {view === "settings" ? (
          <ExtensionManagementPanel
            extensions={extensions}
            settings={extensionSettings}
            currentAppName={appName}
            {...(appIcon ? { currentAppIcon: appIcon } : {})}
            onReload={reloadExtensions}
            onNotice={setNotice}
            {...(api.setAppBranding ? { onSaveBranding: async (branding) => {
              const result = await api.setAppBranding!(branding);
              setAppName(result.appName || "pi remote");
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
              <MessageTimeline
                messages={messagesBySession[activeSession.id] ?? []}
                streaming={activeSession.status === "streaming"}
                enabledArtifactMimes={enabledArtifactMimes}
                sessionId={activeSession.id}
              />
              <ExtensionUiHost
                requests={extensionUiBySession[activeSession.id] ?? []}
                onValueResponse={(id, value) => respondToExtensionUi({ id, value })}
                onConfirmResponse={(id, confirmed) => respondToExtensionUi({ id, confirmed })}
                onCancelResponse={(id) => respondToExtensionUi({ id, cancelled: true })}
              />
              {(messagesBySession[activeSession.id]?.length ?? 0) === 0 ? (
                <InlineNameInput
                  sessionId={activeSession.id}
                  currentName={activeSession.sessionName ?? ""}
                  onCommit={(next) => void commitRename(next)}
                />
              ) : null}
              {promptErrorBySession[activeSession.id] ? (
                <div className="prompt-error-banner" role="alert" aria-label="Prompt error">
                  <div className="prompt-error-text">
                    <strong>Prompt failed.</strong> <span>{promptErrorBySession[activeSession.id]}</span>
                  </div>
                  <div className="prompt-error-actions">
                    <button type="button" onClick={() => setPromptErrorBySession((current) => ({ ...current, [activeSession.id]: null }))}>Dismiss</button>
                  </div>
                </div>
              ) : null}
              <PromptComposer
                sessionId={activeSession.id}
                isStreaming={activeSession.status === "streaming"}
                steeringQueue={steeringBySession[activeSession.id] ?? []}
                followUpQueue={followUpBySession[activeSession.id] ?? []}
                fileSuggestions={["README.md", "package.json", "src/web/main.tsx", "src/server/session/session-registry.ts"]}
                commandSuggestions={commandSuggestions}
                statusText={activeSession.status}
                statusCwd={activeSession.cwd}
                {...(activeSession.model === undefined ? {} : { statusModel: activeSession.model })}
                statusTokens={formatStats(activeSession.stats, activeSession.tokenSummary)}
                onPrompt={handlePrompt}
                onSteer={handleSteer}
                onFollowUp={handleFollowUp}
                onAbort={() => activeSession ? api.abort(activeSession.id) : undefined}
                onBash={handleBash}
                onAbortBash={() => undefined}
                {...(draftSeedBySession[activeSession.id] === undefined ? {} : { draftSeed: draftSeedBySession[activeSession.id] })}
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

      {notice ? (
        <div role="status" aria-live="polite" className="dashboard-notice">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notice">Dismiss</button>
        </div>
      ) : null}

      <ShortcutHelp />

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
function AppBrand({
  appName,
  appIcon,
  onNavigateRoot,
}: {
  readonly appName: string;
  readonly appIcon?: string;
  readonly onNavigateRoot?: () => void;
}) {
  return (
    <a
      className="app-brand"
      href="/"
      aria-label={appName}
      onClick={(event) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        onNavigateRoot?.();
      }}
    >
      {appIcon ? <BrandIcon value={appIcon} /> : null}
      <h1>{appName}</h1>
    </a>
  );
}

/**
 * A plain left-click (no modifier keys, primary mouse button) is the
 * signal that we should handle the navigation in-app. Modifier-clicks
 * (cmd/ctrl/shift/alt) and middle-clicks should fall through to the
 * browser so the user gets a real "open in new tab" affordance from
 * any sidebar item.
 */
function isPlainLeftClick(event: React.MouseEvent): boolean {
  return event.button === 0
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && !event.altKey;
}

function BrandIcon({ value }: { readonly value: string }) {
  return <img className="app-brand-icon" src={value} alt="" aria-hidden="true" />;
}

function updateFavicon(appIcon: string | undefined): void {
  if (typeof document === "undefined") return;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  link.type = "image/svg+xml";
  if (!appIcon) {
    delete link.dataset.piRemoteIconSource;
    link.href = "/favicon.svg";
    return;
  }

  // Start with a safe square SVG wrapper immediately, then refine it after
  // the browser tells us the image's intrinsic dimensions. Chrome's tab-strip
  // favicon renderer has historically stretched non-square bitmap favicons;
  // using explicit SVG image geometry avoids depending on favicon-specific
  // preserveAspectRatio handling for wide logos.
  link.dataset.piRemoteIconSource = appIcon;
  link.href = imageFaviconDataUrl(appIcon);

  const image = new Image();
  image.onload = () => {
    if (link.dataset.piRemoteIconSource !== appIcon) return;
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    link.href = imageFaviconDataUrl(appIcon, { width: image.naturalWidth, height: image.naturalHeight });
  };
  image.src = appIcon;
}

export function imageFaviconDataUrl(imageUrl: string, naturalSize?: { readonly width: number; readonly height: number }): string {
  const href = imageUrl
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const box = 56;
  const size = containedImageBox(naturalSize, box);
  const x = formatSvgNumber((64 - size.width) / 2);
  const y = formatSvgNumber((64 - size.height) / 2);
  const width = formatSvgNumber(size.width);
  const height = formatSvgNumber(size.height);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="transparent"/><image href="${href}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function containedImageBox(naturalSize: { readonly width: number; readonly height: number } | undefined, max: number): { readonly width: number; readonly height: number } {
  if (!naturalSize || naturalSize.width <= 0 || naturalSize.height <= 0) return { width: max, height: max };
  const ratio = naturalSize.width / naturalSize.height;
  return ratio >= 1 ? { width: max, height: max / ratio } : { width: max * ratio, height: max };
}

function formatSvgNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}

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

type MessageSetter = Dispatch<SetStateAction<Record<string, TimelineMessage[]>>>;

type LegacyMessageEvent = {
  readonly type: "message";
  readonly message: {
    readonly role: string;
    readonly content: string;
    readonly timestamp?: number;
    readonly tool?: DashboardToolDetails;
  };
};

function applyRealtimeEvent(
  sessionId: string,
  event: Record<string, unknown>,
  setMessagesBySession: MessageSetter,
  streamDraftIds: Record<string, string>,
): boolean {
  if (event.type === "message_start" && isRecord(event.message)) {
    const message = event.message as unknown as WireMessage;
    if (message.role === "assistant") {
      const draftId = draftIdForSession(sessionId, streamDraftIds);
      setMessagesBySession((current) => ({
        ...current,
        [sessionId]: upsertTimelineMessage(current[sessionId] ?? [], wireMessageToTimeline(draftId, message, true)),
      }));
      return true;
    }
    if (message.role === "user") {
      setMessagesBySession((current) => ({
        ...current,
        [sessionId]: appendDedupeTimelineMessage(current[sessionId] ?? [], wireMessageToTimeline(`user-${message.timestamp ?? Date.now()}`, message, false)),
      }));
      return true;
    }
  }

  if (event.type === "message_update" && isRecord(event.assistantMessageEvent)) {
    const assistantEvent = event.assistantMessageEvent;
    const deltaType = assistantEvent.type;
    const delta = assistantEvent.delta;
    if ((deltaType === "text_delta" || deltaType === "thinking_delta") && typeof delta === "string") {
      const draftId = draftIdForSession(sessionId, streamDraftIds);
      setMessagesBySession((current) => ({
        ...current,
        [sessionId]: appendAssistantDelta(current[sessionId] ?? [], draftId, deltaType, delta),
      }));
      return true;
    }
  }

  if (event.type === "message_end" && isRecord(event.message)) {
    const message = event.message as unknown as WireMessage;
    if (message.role === "assistant") {
      const draftId = streamDraftIds[sessionId] ?? draftIdForSession(sessionId, streamDraftIds);
      delete streamDraftIds[sessionId];
      setMessagesBySession((current) => ({
        ...current,
        [sessionId]: upsertTimelineMessage(current[sessionId] ?? [], wireMessageToTimeline(draftId, message, false)),
      }));
      return false;
    }
  }

  if (event.type === "message" && isRecord(event.message)) {
    const legacy = event as LegacyMessageEvent;
    setMessagesBySession((current) => ({
      ...current,
      [sessionId]: appendDedupeTimelineMessage(current[sessionId] ?? [], legacyMessageToTimeline(legacy.message)),
    }));
    return true;
  }

  if (event.type === "tool_execution_start" && typeof event.toolCallId === "string" && typeof event.toolName === "string") {
    const toolCallId = event.toolCallId;
    const toolName = event.toolName;
    setMessagesBySession((current) => ({
      ...current,
      [sessionId]: upsertTimelineMessage(current[sessionId] ?? [], {
        id: `tool-${toolCallId}`,
        role: "tool",
        text: "",
        tool: {
          id: toolCallId,
          name: toolName,
          args: isRecord(event.args) ? event.args : {},
          status: "running",
          output: "",
          startedAt: Date.now(),
        },
      }),
    }));
    return true;
  }

  if ((event.type === "tool_execution_update" || event.type === "tool_execution_end") && typeof event.toolCallId === "string" && typeof event.toolName === "string") {
    const toolCallId = event.toolCallId;
    const toolName = event.toolName;
    const result = event.type === "tool_execution_update" ? event.partialResult : event.result;
    const artifact = extractArtifact(result);
    setMessagesBySession((current) => ({
      ...current,
      [sessionId]: upsertTimelineMessage(current[sessionId] ?? [], {
        id: `tool-${toolCallId}`,
        role: "tool",
        text: "",
        tool: {
          id: toolCallId,
          name: toolName,
          args: {},
          status: event.type === "tool_execution_end" ? (event.isError ? "error" : "success") : "running",
          output: toolResultText(result),
          ...(artifact === undefined ? {} : { artifact }),
          ...(event.type === "tool_execution_end" ? { completedAt: Date.now() } : {}),
        },
      }),
    }));
    return event.type === "tool_execution_update";
  }

  return false;
}

function draftIdForSession(sessionId: string, streamDraftIds: Record<string, string>): string {
  const existing = streamDraftIds[sessionId];
  if (existing) return existing;
  const next = `assistant-stream-${sessionId}-${Date.now()}`;
  streamDraftIds[sessionId] = next;
  return next;
}

function appendAssistantDelta(
  messages: readonly TimelineMessage[],
  draftId: string,
  deltaType: "text_delta" | "thinking_delta",
  delta: string,
): TimelineMessage[] {
  const existing = messages.find((message) => message.id === draftId);
  const base: TimelineMessage = existing ?? { id: draftId, role: "assistant", text: "", provider: "pi" };
  const updated: TimelineMessage = deltaType === "text_delta"
    ? { ...base, text: `${base.text}${delta}` }
    : { ...base, thinking: `${base.thinking ?? ""}${delta}` };
  return upsertTimelineMessage(messages, updated);
}

function upsertTimelineMessage(messages: readonly TimelineMessage[], message: TimelineMessage): TimelineMessage[] {
  const index = messages.findIndex((existing) => existing.id === message.id);
  if (index === -1) return [...messages, message];
  return [...messages.slice(0, index), mergeTimelineMessage(messages[index]!, message), ...messages.slice(index + 1)];
}

function mergeTimelineMessage(previous: TimelineMessage, next: TimelineMessage): TimelineMessage {
  if (previous.role === "tool" && previous.tool && next.tool) {
    return {
      ...previous,
      ...next,
      tool: {
        ...previous.tool,
        ...next.tool,
        args: Object.keys(next.tool.args).length ? next.tool.args : previous.tool.args,
      },
    };
  }
  return { ...previous, ...next };
}

function appendDedupeTimelineMessage(messages: readonly TimelineMessage[], message: TimelineMessage): TimelineMessage[] {
  const last = messages.at(-1);
  if (last?.role === message.role && last.text === message.text) return [...messages];
  return [...messages, message];
}

function wireMessageToTimeline(id: string, message: WireMessage, forceAssistantProvider: boolean): TimelineMessage {
  const role = timelineRole(message.role);
  const { text, thinking } = contentTextAndThinking(message.content);
  return {
    id,
    role,
    text,
    ...(thinking ? { thinking } : {}),
    ...(forceAssistantProvider || role === "assistant" ? { provider: "pi" } : {}),
    ...(message.customType === undefined ? {} : { customType: message.customType }),
    ...extractArtifactTimeline(message.customType, message.details),
  };
}

function extractArtifactTimeline(
  customType: string | undefined,
  details: Record<string, unknown> | undefined,
): { readonly artifact?: import("./MessageTimeline.js").TimelineArtifactDetails } {
  if (customType !== "artifact" || !isRecord(details)) return {};
  const artifacts = Array.isArray(details.artifacts) ? details.artifacts : undefined;
  const artifactGroupId = typeof details.artifactGroupId === "string" ? details.artifactGroupId : undefined;
  if (!artifacts || !artifactGroupId) return {};
  return {
    artifact: {
      artifactGroupId,
      artifacts: artifacts as unknown as readonly import("./MessageTimeline.js").TimelineArtifactRepresentation[],
      ...(typeof details.version === "number" ? { version: details.version } : {}),
      ...(typeof details.caption === "string" ? { caption: details.caption } : {}),
    },
  };
}

function legacyMessageToTimeline(message: LegacyMessageEvent["message"]): TimelineMessage {
  const role = timelineRole(message.role);
  return {
    id: `${message.timestamp ?? Date.now()}-${role}`,
    role,
    text: message.content,
    ...(role === "assistant" ? { provider: "pi" } : {}),
    ...(message.tool === undefined ? {} : { tool: message.tool }),
  };
}

function timelineRole(role: string): TimelineMessage["role"] {
  if (role === "assistant" || role === "user" || role === "tool") return role;
  return "custom";
}

function contentText(content: unknown): string {
  return contentTextAndThinking(content).text;
}

/**
 * Split a wire-message content array into its visible-text and thinking
 * components. Mirrors the server-side helper in pirpc-pi-adapter so SSE
 * `message_update` / `message_end` events stay consistent with the post-
 * reload pipeline (PR #47): the assistant bubble renders only `text`,
 * the Thought card renders only `thinking`, and we never flatten the
 * two into a single Markdown body.
 */
function contentTextAndThinking(content: unknown): { text: string; thinking: string } {
  if (typeof content === "string") return { text: content, thinking: "" };
  if (!Array.isArray(content)) return { text: content === undefined ? "" : JSON.stringify(content), thinking: "" };
  const text: string[] = [];
  const thinking: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if ("thinking" in block && typeof (block as { thinking: unknown }).thinking === "string") {
      thinking.push(String((block as { thinking: string }).thinking));
      continue;
    }
    if ("text" in block && typeof (block as { text: unknown }).text === "string") {
      text.push(String((block as { text: string }).text));
      continue;
    }
    if ("type" in block && (block as { type?: unknown }).type === "toolCall") {
      continue;
    }
    text.push(JSON.stringify(block));
  }
  return { text: text.filter(Boolean).join("\n"), thinking: thinking.join("\n\n") };
}

function toolResultText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  return result.content.map((item) => isRecord(item) ? String(item.text ?? "") : "").join("\n");
}

function extractArtifact(result: unknown): DashboardArtifact | undefined {
  if (!isRecord(result) || !isRecord(result.details)) return undefined;
  const artifact = result.details.piRemoteControlArtifact;
  if (!isRecord(artifact) || typeof artifact.kind !== "string") return undefined;
  return artifact as unknown as DashboardArtifact;
}

function upsertExtensionUiRequest(requests: readonly ExtensionUiRequest[], request: ExtensionUiRequest): ExtensionUiRequest[] {
  const withoutSameTarget = requests.filter((existing) => {
    if (existing.id === request.id) return false;
    if (existing.method === "setStatus" && request.method === "setStatus") return existing.statusKey !== request.statusKey;
    if (existing.method === "setWidget" && request.method === "setWidget") return existing.widgetKey !== request.widgetKey;
    if (existing.method === "setTitle" && request.method === "setTitle") return false;
    return true;
  });
  return [...withoutSameTarget, request];
}

function isExtensionUiRequest(value: Record<string, unknown>): value is ExtensionUiRequest {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSessionCardData(value: unknown): value is SessionCardData {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.cwd === "string"
    && typeof value.status === "string"
    && typeof value.lastActivity === "number";
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
  return {
    type: attachment.type,
    name: attachment.name,
    ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
    ...(attachment.data === undefined ? {} : { data: attachment.data }),
  };
}

function basename(value: string): string {
  return value.split("/").filter(Boolean).at(-1) ?? value;
}

function resolveForkSelection(messages: readonly BranchMessageOption[], input: string): BranchMessageOption | undefined {
  const maybeIndex = Number(input);
  if (Number.isInteger(maybeIndex) && maybeIndex >= 1 && maybeIndex <= messages.length) return messages[maybeIndex - 1];
  return messages.find((message) => message.entryId === input || message.entryId.startsWith(input));
}

function truncate(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function readSessionFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get("session");
}

// ---------- 'Recent' sort: last-user-activity persistence ----------
//
// We persist the per-session 'last user activity' timestamps in localStorage
// so a reload or new tab preserves the same sidebar order the user
// established. Failures (no localStorage, quota errors, parse errors) all
// degrade silently to an empty map.
const USER_ACTIVITY_STORAGE_KEY = "pi-remote-control:lastUserActivityById:v1";

function recentSortKey(session: SessionCardData, optimisticUserActivityById: Record<string, number>): number {
  if (typeof session.lastUserActivity === "number" && Number.isFinite(session.lastUserActivity)) {
    return session.lastUserActivity;
  }
  const optimistic = optimisticUserActivityById[session.id];
  if (typeof optimistic === "number" && Number.isFinite(optimistic)) return optimistic;
  if (typeof session.createdAt === "number" && Number.isFinite(session.createdAt)) return session.createdAt;
  return session.lastActivity;
}

function loadUserActivityMap(): Record<string, number> {
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

function saveUserActivityMap(map: Record<string, number>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(USER_ACTIVITY_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota / private-mode failures are not worth surfacing.
  }
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
        <p>This activity was contributed by a PRC extension. Custom web rendering will be enabled as the extension framework matures.</p>
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

function formatExtensionCommandResult(result: unknown, title: string): string {
  if (typeof result === "string" && result.trim()) return result;
  if (typeof result === "number" || typeof result === "boolean") return String(result);
  if (result && typeof result === "object") return `${title}: ${JSON.stringify(result)}`;
  return `${title} completed.`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function formatStats(
  stats: import("../api/session-api.js").SessionCardStats | undefined,
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

function formatPercent(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const percent = Math.max(0, Math.min(100, value));
  if (percent > 0 && percent < 1) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

function compactNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function shortSessionId(id: string): string {
  const compact = id.replace(/-/g, "");
  return compact.length > 8 ? compact.slice(0, 8) : compact;
}

function FilterGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 4h12" />
      <path d="M4 8h8" />
      <path d="M6 12h4" />
    </svg>
  );
}

function ForkGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.4" />
      <circle cx="4.5" cy="12.5" r="1.4" />
      <circle cx="11.5" cy="6.5" r="1.4" />
      <path d="M4.5 5v6" />
      <path d="M4.5 9c0-2 2-3 4-3h1.5" />
    </svg>
  );
}

function CloneGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M3.5 10.5V3.5a1 1 0 0 1 1-1h6" />
    </svg>
  );
}

function PencilGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.5 2.5l3 3-8 8H2.5V10.5z" />
      <path d="M9 4l3 3" />
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4.5h10" />
      <path d="M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5" />
      <path d="M4.5 4.5l.6 8.2a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.2" />
      <path d="M7 7.5v4" />
      <path d="M9 7.5v4" />
    </svg>
  );
}

function SidebarToggleGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <line x1="6" y1="3" x2="6" y2="13" />
    </svg>
  );
}

function NewSessionGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M8 5.5v5" />
      <path d="M5.5 8h5" />
    </svg>
  );
}

function LoadingEllipsisIcon() {
  return (
    <span className="loading-ellipsis-icon" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function CronGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}

function ExtensionGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 2.5h3" />
      <path d="M6.5 13.5h3" />
      <path d="M2.5 6.5v3" />
      <path d="M13.5 6.5v3" />
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" />
      <path d="M7 7h2v2H7z" />
    </svg>
  );
}

function mergeSessionStatusSnapshot(
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
      ...(next.sessionName === undefined ? {} : { sessionName: next.sessionName }),
      ...(next.model === undefined ? {} : { model: next.model }),
      ...(next.tokenSummary === undefined ? {} : { tokenSummary: next.tokenSummary }),
      ...(next.stats === undefined ? {} : { stats: next.stats }),
      ...(next.createdAt === undefined ? {} : { createdAt: next.createdAt }),
      ...(next.lastUserActivity === undefined ? {} : { lastUserActivity: next.lastUserActivity }),
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

function sessionStatusPollIntervalMs(): number {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return 15_000;
  return 4_000;
}

function toTimelineMessage(message: import("../api/session-api.js").DashboardMessage): TimelineMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    ...(message.thinking === undefined ? {} : { thinking: message.thinking }),
    ...(message.provider === undefined ? {} : { provider: message.provider }),
    ...(message.model === undefined ? {} : { model: message.model }),
    ...(message.stopReason === undefined ? {} : { stopReason: message.stopReason }),
    ...(message.tokenUsage === undefined ? {} : { tokenUsage: message.tokenUsage }),
    ...(message.cost === undefined ? {} : { cost: message.cost }),
    ...(message.error === undefined ? {} : { error: message.error }),
    ...(message.tool === undefined ? {} : { tool: message.tool }),
    ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
    ...(message.customType === undefined ? {} : { customType: message.customType }),
    ...(message.summaryKind === undefined ? {} : { summaryKind: message.summaryKind }),
    ...extractArtifactTimeline(message.customType, message.details),
    ...(message.images && message.images.length > 0
      ? {
          images: message.images.map((image, index) => ({
            id: `${message.id}-img-${index}`,
            // Prefer the server-hosted URL (set when the server strips inline
            // base64 to keep /messages payloads small). Fall back to the
            // inline data URL for back-compat with smaller responses.
            src: image.url
              ? `${import.meta.env.VITE_PI_REMOTE_API_BASE ?? ""}${image.url}`
              : `data:${image.mimeType};base64,${image.data ?? ""}`,
            alt: "image attachment",
          })),
        }
      : {}),
  };
}

/**
 * Returns true if `candidate` is the same as or a subdirectory of `root`.
 * String-comparison only — we don't have node's path.resolve / relative
 * in the browser, but both inputs come from the server which already
 * resolved them, so a normalised prefix check is sufficient.
 */
function isWithin(candidate: string, root: string): boolean {
  if (!candidate || !root) return false;
  const c = candidate.replace(/\/+$/, "");
  const r = root.replace(/\/+$/, "");
  return c === r || c.startsWith(`${r}/`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
