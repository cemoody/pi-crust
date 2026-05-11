import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { WireMessage } from "../../shared/protocol.js";
import type { DashboardMessage, DashboardToolDetails, SessionCardData, SessionDashboardApi } from "../api/session-api.js";
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
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);
  const streamDraftIdsRef = useRef<Record<string, string>>({});

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

    const applyStreamEvent = (event: unknown) => {
      if (cancelled || !isRecord(event) || typeof event.type !== "string") return;
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

    void refresh();
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

  async function createSession() {
    setError(null);
    const created = await api.createSession({ cwd, ...(sessionName.trim() ? { sessionName: sessionName.trim() } : {}) });
    setSessions((current) => [created, ...current]);
    setMessagesBySession((current) => ({ ...current, [created.id]: [] }));
    setActiveSessionId(created.id);
    setSessionName("");
    setNewSessionOpen(false);
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
          <button type="button" onClick={() => setNewSessionOpen(true)}>New session</button>
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

      {newSessionOpen ? (
        <div className="new-session-backdrop" role="presentation" onClick={() => setNewSessionOpen(false)}>
          <form
            className="new-session-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Create new session"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void createSession();
            }}
          >
            <header>
              <h2>New session</h2>
              <button type="button" onClick={() => setNewSessionOpen(false)} aria-label="Close new session dialog">×</button>
            </header>
            <div className="new-session-fields">
              <label>
                CWD
                <input autoFocus value={cwd} onChange={(event) => setCwd(event.target.value)} aria-label="New session cwd" />
              </label>
              <label>
                Name <span>optional</span>
                <input value={sessionName} onChange={(event) => setSessionName(event.target.value)} aria-label="New session name" placeholder="Untitled session" />
              </label>
            </div>
            <footer>
              <button type="button" onClick={() => setNewSessionOpen(false)}>Cancel</button>
              <button type="submit" className="primary">Create session</button>
            </footer>
          </form>
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
        },
      }),
    }));
    return true;
  }

  if ((event.type === "tool_execution_update" || event.type === "tool_execution_end") && typeof event.toolCallId === "string" && typeof event.toolName === "string") {
    const toolCallId = event.toolCallId;
    const toolName = event.toolName;
    const result = event.type === "tool_execution_update" ? event.partialResult : event.result;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
