import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionCardData, SessionDashboardApi } from "../api/session-api.js";
import iconBlack from "../assets-icon-black.svg";
import { MessageTimeline, type TimelineMessage } from "./MessageTimeline.js";
import { ModelPicker } from "./ModelPicker.js";
import { PromptComposer, type ComposerAttachment } from "./PromptComposer.js";
import { ShortcutHelp } from "./ShortcutHelp.js";
import "./session-dashboard.css";

export interface SessionDashboardProps {
  readonly api: SessionDashboardApi;
}

type SortMode = "recent" | "name" | "cwd";

export function SessionDashboard({ api }: SessionDashboardProps) {
  const [sessions, setSessions] = useState<readonly SessionCardData[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => readSessionFromUrl());
  const [cwd, setCwd] = useState("");
  const [sessionName, setSessionName] = useState("");
  const [query, setQuery] = useState("");
  const [showPaths, setShowPaths] = useState(false);
  const [namedOnly, setNamedOnly] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [error, setError] = useState<string | null>(null);
  const [messagesBySession, setMessagesBySession] = useState<Record<string, TimelineMessage[]>>({});
  const [steeringBySession, setSteeringBySession] = useState<Record<string, string[]>>({});
  const [followUpBySession, setFollowUpBySession] = useState<Record<string, string[]>>({});
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);

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
        setCwd(defaultCwd);
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

    const refresh = async () => {
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
              lastActivity: refreshed.lastActivity,
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

    void refresh();
    const unsubscribe = api.streamEvents ? api.streamEvents(activeSessionId, scheduleRefresh) : () => undefined;

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

  async function createSession() {
    setError(null);
    const created = await api.createSession({ cwd, ...(sessionName.trim() ? { sessionName: sessionName.trim() } : {}) });
    setSessions((current) => [created, ...current]);
    setMessagesBySession((current) => ({ ...current, [created.id]: [] }));
    setActiveSessionId(created.id);
    setSessionName("");
  }

  function beginRename() {
    if (!activeSession) return;
    setDeletePending(false);
    setRenameDraft(activeSession.sessionName ?? "");
  }

  function cancelRename() {
    setRenameDraft(null);
  }

  async function commitRename() {
    if (!activeSession || renameDraft === null) return;
    const next = renameDraft.trim();
    setRenameDraft(null);
    if (!next || next === (activeSession.sessionName ?? "")) return;
    const captured = activeSession;
    await api.renameSession(captured.id, next);
    setSessions((current) => current.map((session) => session.id === captured.id ? { ...session, sessionName: next } : session));
  }

  function beginDelete() {
    if (!activeSession) return;
    setRenameDraft(null);
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
    const now = Date.now();
    appendMessage(activeSession.id, {
      id: `user-pending-${now}`,
      role: "user",
      text,
      images: attachments.filter((attachment) => attachment.previewUrl).map((attachment) => ({
        id: attachment.id,
        src: attachment.previewUrl!,
        alt: attachment.name,
      })),
    });
    setSessions((current) => current.map((session) => session.id === activeSession.id ? { ...session, status: "streaming" } : session));
    try {
      const messages = await api.prompt(activeSession.id, text);
      if (Array.isArray(messages) && messages.length > 0) {
        setMessagesBySession((current) => ({ ...current, [activeSession.id]: messages.map(toTimelineMessage) }));
      }
    } catch (caught) {
      appendMessage(activeSession.id, { id: `error-${now}`, role: "custom", customLabel: "Error", text: errorMessage(caught) });
    } finally {
      setSessions((current) => current.map((session) => session.id === activeSession.id ? { ...session, status: "idle" } : session));
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
        setNotice("Available: /model, /session, /new, /name <name>, /quit, /help");
        return;
      default:
        setNotice(`Command \"/${name}\" is recognised in the TUI but not yet implemented in the WUI.`);
    }
  }

  async function handleBash(command: string, includeInContext: boolean) {
    if (!activeSession) return;
    const now = Date.now();
    appendMessage(activeSession.id, {
      id: `bash-${now}`,
      role: "custom",
      customLabel: includeInContext ? "Shell command" : "Hidden shell command",
      text: `$ ${command}\nSending to Pi...`,
    });
    try {
      const messages = await api.bash(activeSession.id, command, includeInContext);
      setMessagesBySession((current) => ({ ...current, [activeSession.id]: messages.map(toTimelineMessage) }));
    } catch (caught) {
      appendMessage(activeSession.id, { id: `error-${now}`, role: "custom", customLabel: "Error", text: errorMessage(caught) });
    }
  }

  return (
    <main className={`session-dashboard ${sidebarOpen ? "" : "collapsed"}`}>
      <button
        type="button"
        className="sidebar-toggle"
        aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
        aria-pressed={sidebarOpen}
        onClick={() => setSidebarOpen((open) => !open)}
      >
        <SidebarToggleGlyph />
      </button>

      <aside className="session-sidebar" aria-label="Sessions" aria-hidden={!sidebarOpen}>
        <header>
          <img src={iconBlack} alt="" aria-hidden="true" />
          <h1>pi remote</h1>
          <p>{sessions.length} sessions</p>
        </header>

        <section aria-label="Create session" className="session-create">
          <label>
            CWD
            <input value={cwd} onChange={(event) => setCwd(event.target.value)} aria-label="New session cwd" />
          </label>
          <label>
            Name
            <input value={sessionName} onChange={(event) => setSessionName(event.target.value)} aria-label="New session name" />
          </label>
          <button type="button" onClick={() => void createSession()}>New session</button>
        </section>

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
                <label className="popover-row">
                  <input type="checkbox" checked={showPaths} onChange={(event) => setShowPaths(event.target.checked)} />
                  <span>Show paths</span>
                </label>
                <label className="popover-row">
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
                onClick={() => setActiveSessionId(session.id)}
              >
                <span className="session-row-name">{session.sessionName ?? "Untitled session"}</span>
                <span className="session-row-status">{session.status}</span>
                <span className="session-row-id">
                  <code>{shortSessionId(session.id)}</code>
                  {showPaths ? <> · <span>{session.cwd}</span></> : <> · <span>{basename(session.cwd)}</span></>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="active-session" aria-label="Active session">
        {activeSession ? (
          <>
            <header>
              {renameDraft !== null ? (
                <div className="inline-rename" role="group" aria-label="Rename session">
                  <input
                    autoFocus
                    aria-label="Session name"
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void commitRename();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        cancelRename();
                      }
                    }}
                  />
                  <button type="button" className="primary" onClick={() => void commitRename()}>Save</button>
                  <button type="button" onClick={cancelRename}>Cancel</button>
                </div>
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
                    <button type="button" onClick={beginRename}>Rename</button>
                    <button type="button" className="ghost-danger" onClick={beginDelete}>Delete</button>
                  </div>
                </>
              )}
            </header>

            <div className="active-session-workspace">
              <MessageTimeline
                messages={messagesBySession[activeSession.id] ?? []}
                streaming={activeSession.status === "streaming"}
              />
              <PromptComposer
                sessionId={activeSession.id}
                isStreaming={activeSession.status === "streaming"}
                steeringQueue={steeringBySession[activeSession.id] ?? []}
                followUpQueue={followUpBySession[activeSession.id] ?? []}
                fileSuggestions={["README.md", "package.json", "src/web/main.tsx", "src/server/session/session-registry.ts"]}
                commandSuggestions={["model", "settings", "tree", "compact", "session", "new"]}
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
                onSlashCommand={handleSlashCommand}
              />
            </div>
          </>
        ) : (
          <p>Select or create a session.</p>
        )}
      </section>

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

function basename(value: string): string {
  return value.split("/").filter(Boolean).at(-1) ?? value;
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
  if (stats.contextPercent !== null) parts.push(`${Math.max(0, Math.min(100, stats.contextPercent))}%`);
  if (stats.contextWindow !== null) parts.push(compactNumber(stats.contextWindow));
  return parts.join(" ");
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

function SidebarToggleGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="2.5" y1="4" x2="13.5" y2="4" />
      <line x1="2.5" y1="8" x2="13.5" y2="8" />
      <line x1="2.5" y1="12" x2="13.5" y2="12" />
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
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
