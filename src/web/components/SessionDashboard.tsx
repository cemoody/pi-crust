import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ExtensionUiRequest, ExtensionUiResponse, WireMessage } from "../../shared/protocol.js";
import type { DashboardArtifact, DashboardMessage, DashboardToolDetails, ForkMessageOption, SessionCardData, SessionDashboardApi } from "../api/session-api.js";
import { MAX_PROMPT_CHARS } from "../../shared/limits.js";
import { MessageTimeline, type TimelineMessage } from "./MessageTimeline.js";
import { ModelPicker } from "./ModelPicker.js";
import { PromptComposer, type ComposerAttachment } from "./PromptComposer.js";
import { ShortcutHelp } from "./ShortcutHelp.js";
import { ExtensionUiHost } from "./ExtensionUiHost.js";
import { CronPanel } from "./CronPanel.js";
import "./session-dashboard.css";

type DashboardView = "sessions" | "cron";

export interface SessionDashboardProps {
  readonly api: SessionDashboardApi;
}

type SortMode = "recent" | "name" | "cwd";

export function SessionDashboard({ api }: SessionDashboardProps) {
  const [sessions, setSessions] = useState<readonly SessionCardData[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => readSessionFromUrl());
  const [defaultCwd, setDefaultCwd] = useState("");
  const [query, setQuery] = useState("");
  const [showPaths, setShowPaths] = useState(false);
  const [namedOnly, setNamedOnly] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [error, setError] = useState<string | null>(null);
  const [messagesBySession, setMessagesBySession] = useState<Record<string, TimelineMessage[]>>({});
  const [steeringBySession, setSteeringBySession] = useState<Record<string, string[]>>({});
  const [followUpBySession, setFollowUpBySession] = useState<Record<string, string[]>>({});
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(max-width: 720px)").matches;
  });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [view, setView] = useState<DashboardView>("sessions");
  const [renaming, setRenaming] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);
  const [promptErrorBySession, setPromptErrorBySession] = useState<Record<string, string | null>>({});
  const [extensionUiBySession, setExtensionUiBySession] = useState<Record<string, ExtensionUiRequest[]>>({});
  const [forkDialogOpen, setForkDialogOpen] = useState(false);
  const [forkMessages, setForkMessages] = useState<readonly ForkMessageOption[]>([]);
  const [forkBusy, setForkBusy] = useState(false);
  const [forkError, setForkError] = useState<string | null>(null);
  const [draftSeedBySession, setDraftSeedBySession] = useState<Record<string, { readonly id: string; readonly value: string }>>({});
  const streamDraftIdsRef = useRef<Record<string, string>>({});

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
    let cancelled = false;
    void (async () => {
      try {
        const defaultCwd = api.getDefaultCwd ? await api.getDefaultCwd() : "/tmp/project";
        if (cancelled) return;
        setDefaultCwd(defaultCwd);
        setSessions(await api.listSessions(defaultCwd));
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

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

    const refresh = async (options: { readonly preserveLastActivity?: boolean } = {}) => {
      try {
        const [messages, refreshed] = await Promise.all([
          api.getMessages(activeSessionId),
          api.getSession ? api.getSession(activeSessionId) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setMessagesBySession((current) => ({ ...current, [activeSessionId]: messages.map(toTimelineMessage) }));
        if (refreshed) {
          setSessions((current) => current.map((session) => {
            if (session.id !== refreshed.id) return session;
            return {
              ...session,
              status: refreshed.status,
              ...(refreshed.model === undefined ? {} : { model: refreshed.model }),
              ...(refreshed.tokenSummary === undefined ? {} : { tokenSummary: refreshed.tokenSummary }),
              ...(refreshed.stats === undefined ? {} : { stats: refreshed.stats }),
              lastActivity: options.preserveLastActivity ? session.lastActivity : refreshed.lastActivity,
            };
          }));
        }
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      }
    };

    const scheduleRefresh = () => {
      if (cancelled) return;
      if (pendingRefresh) clearTimeout(pendingRefresh);
      pendingRefresh = setTimeout(() => {
        pendingRefresh = undefined;
        void refresh();
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
    void refresh({ preserveLastActivity: true });
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
      return b.lastActivity - a.lastActivity;
    });
  }, [namedOnly, query, sessions, sortMode]);

  const activeSession = activeSessionId ? sessions.find((session) => session.id === activeSessionId) : null;

  async function createSession(input?: { readonly cwd?: string; readonly sessionName?: string }) {
    setError(null);
    const nextCwd = input?.cwd?.trim() || defaultCwd;
    const nextName = input?.sessionName?.trim() ?? "";
    const created = await api.createSession({ cwd: nextCwd, ...(nextName ? { sessionName: nextName } : {}) });
    setSessions((current) => [created, ...current]);
    setMessagesBySession((current) => ({ ...current, [created.id]: [] }));
    setActiveSessionId(created.id);
    setNewSessionOpen(false);
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
    setSessions((current) => current.map((session) => session.id === sessionId ? { ...session, status: "streaming" } : session));
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

  async function openForkDialog(argv = "") {
    if (!activeSession) return;
    if (!api.getForkMessages || !api.forkSession) {
      setNotice("This session adapter does not support /fork yet.");
      return;
    }
    setForkBusy(true);
    setForkError(null);
    setForkDialogOpen(true);
    try {
      const messages = await api.getForkMessages(activeSession.id);
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
    if (!activeSession || !api.forkSession) return;
    setForkBusy(true);
    setForkError(null);
    try {
      const result = await api.forkSession(activeSession.id, entryId);
      if (result.cancelled) {
        setNotice("Fork cancelled by extension.");
        return;
      }
      const session = result.session;
      setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
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
    if (!api.cloneSession) {
      setNotice("This session adapter does not support /clone yet.");
      return;
    }
    try {
      const result = await api.cloneSession(activeSession.id);
      if (result.cancelled) {
        setNotice("Clone cancelled by extension.");
        return;
      }
      const session = result.session;
      setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
      setMessagesBySession((current) => ({ ...current, [session.id]: [] }));
      setActiveSessionId(session.id);
      setNotice("Cloned session.");
    } catch (caught) {
      setNotice(errorMessage(caught));
    }
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
        await createSession();
        return;
      case "fork":
        await openForkDialog(argv);
        return;
      case "clone":
        await cloneActiveSession();
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
        setNotice("Available: /model, /session, /new, /fork, /clone, /name <name>, /quit, /help");
        return;
      default:
        setNotice(`Command \"/${name}\" is recognised in the TUI but not yet implemented in the WUI.`);
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
    setPromptErrorBySession((current) => ({ ...current, [sessionId]: null }));
    appendMessage(sessionId, {
      id: `bash-${now}`,
      role: "custom",
      customLabel: includeInContext ? "Shell command" : "Hidden shell command",
      text: `$ ${command}\nSending to Pi...`,
    });
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
          <h1>pi remote</h1>
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
          <button
            type="button"
            className="sidebar-menu-item"
            onClick={() => { setView("sessions"); setNewSessionOpen(true); }}
          >
            New session
          </button>
          <button
            type="button"
            className={`sidebar-menu-item ${view === "cron" ? "active" : ""}`}
            aria-pressed={view === "cron"}
            onClick={() => setView(view === "cron" ? "sessions" : "cron")}
          >
            Cron
          </button>
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
              <button
                type="button"
                className={session.id === activeSessionId ? "active" : ""}
                onClick={() => { setActiveSessionId(session.id); setView("sessions"); }}
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
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="active-session" aria-label={view === "cron" ? "Cron jobs" : "Active session"}>
        {view === "cron" && api.cron ? (
          <CronPanel
            api={api.cron}
            defaultCwd={defaultCwd}
            onOpenSession={(sessionId) => {
              setView("sessions");
              setActiveSessionId(sessionId);
              void (async () => {
                try {
                  setSessions(await api.listSessions(defaultCwd));
                } catch (caught) {
                  setError(errorMessage(caught));
                }
              })();
            }}
          />
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
                    <button type="button" className="action-icon" aria-label="Compact" title="Compact is not implemented in the web UI yet" disabled>
                      <CompactGlyph />
                    </button>
                    <button type="button" className="action-icon" aria-label="Fork" title="Fork session from a previous message" onClick={() => void handleSlashCommand("fork", "")}>
                      <ForkGlyph />
                    </button>
                    <button type="button" className="action-icon" aria-label="Tree" title="Tree is not implemented in the web UI yet" disabled>
                      <TreeGlyph />
                    </button>
                    <button type="button" className="action-icon" aria-label="Clone" title="Clone is not implemented in the web UI yet" disabled>
                      <CloneGlyph />
                    </button>
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
              />
              <ExtensionUiHost
                requests={extensionUiBySession[activeSession.id] ?? []}
                onValueResponse={(id, value) => respondToExtensionUi({ id, value })}
                onConfirmResponse={(id, confirmed) => respondToExtensionUi({ id, confirmed })}
                onCancelResponse={(id) => respondToExtensionUi({ id, cancelled: true })}
              />
              {promptErrorBySession[activeSession.id] ? (
                <div className="prompt-error-banner" role="alert" aria-label="Prompt error">
                  <div className="prompt-error-text">
                    <strong>Prompt failed.</strong> <span>{promptErrorBySession[activeSession.id]}</span>
                  </div>
                  <div className="prompt-error-actions">
                    <button type="button" onClick={() => void handleSlashCommand("compact", "")}>Compact</button>
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
                commandSuggestions={["model", "settings", "tree", "compact", "session", "new", "fork", "clone"]}
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

      {newSessionOpen ? (
        <NewSessionDialog
          initialCwd={defaultCwd}
          onCreate={(input) => void createSession(input)}
          onCancel={() => setNewSessionOpen(false)}
        />
      ) : null}

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
  readonly onCreate: (input: { readonly cwd: string; readonly sessionName?: string }) => void;
  readonly onCancel: () => void;
}) {
  const [cwd, setCwd] = useState(props.initialCwd);
  const [sessionName, setSessionName] = useState("");

  function submit() {
    const name = sessionName.trim();
    props.onCreate({ cwd, ...(name ? { sessionName: name } : {}) });
  }

  return (
    <div className="new-session-backdrop" role="presentation" onClick={props.onCancel}>
      <form
        className="new-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Create new session"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <header>
          <h2>New session</h2>
          <button type="button" onClick={props.onCancel} aria-label="Close new session dialog">×</button>
        </header>
        <div className="new-session-fields">
          <label>
            CWD
            <input
              autoFocus
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              aria-label="New session cwd"
              ref={(node) => {
                // Place caret at the start so the path's leading characters are
                // visible on narrow phones rather than the tail.
                if (node && document.activeElement === node) {
                  node.setSelectionRange(0, 0);
                  node.scrollLeft = 0;
                }
              }}
              onFocus={(event) => {
                event.currentTarget.setSelectionRange(0, 0);
                event.currentTarget.scrollLeft = 0;
              }}
            />
          </label>
          <label>
            Name <span>optional</span>
            <input value={sessionName} onChange={(event) => setSessionName(event.target.value)} aria-label="New session name" placeholder="Untitled session" />
          </label>
        </div>
        <footer>
          <button type="button" onClick={props.onCancel}>Cancel</button>
          <button type="submit" className="primary">Create session</button>
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
  return {
    id,
    role,
    text: contentText(message.content),
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
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block && typeof block === "object" && "text" in block) return String((block as { text: unknown }).text);
      if (block && typeof block === "object" && "thinking" in block) return String((block as { thinking: unknown }).thinking);
      if (block && typeof block === "object" && "type" in block && (block as { type?: unknown }).type === "toolCall") return "";
      return JSON.stringify(block);
    }).filter(Boolean).join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content);
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

function resolveForkSelection(messages: readonly ForkMessageOption[], input: string): ForkMessageOption | undefined {
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

function CompactGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 5h10" />
      <path d="M5 8h6" />
      <path d="M7 11h2" />
      <path d="M2 13h12" />
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

function TreeGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="3.5" cy="3.5" r="1.3" />
      <circle cx="3.5" cy="12.5" r="1.3" />
      <circle cx="12.5" cy="8" r="1.3" />
      <path d="M3.5 5v6" />
      <path d="M4.6 8h6.6" />
      <path d="M3.5 8h1.1" />
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

function toTimelineMessage(message: import("../api/session-api.js").DashboardMessage): TimelineMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    ...(message.provider === undefined ? {} : { provider: message.provider }),
    ...(message.model === undefined ? {} : { model: message.model }),
    ...(message.stopReason === undefined ? {} : { stopReason: message.stopReason }),
    ...(message.tokenUsage === undefined ? {} : { tokenUsage: message.tokenUsage }),
    ...(message.cost === undefined ? {} : { cost: message.cost }),
    ...(message.error === undefined ? {} : { error: message.error }),
    ...(message.tool === undefined ? {} : { tool: message.tool }),
    ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
    ...(message.customType === undefined ? {} : { customType: message.customType }),
    ...extractArtifactTimeline(message.customType, message.details),
    ...(message.images && message.images.length > 0
      ? {
          images: message.images.map((image, index) => ({
            id: `${message.id}-img-${index}`,
            src: `data:${image.mimeType};base64,${image.data}`,
            alt: "image attachment",
          })),
        }
      : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
