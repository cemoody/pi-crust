import { useEffect, useMemo, useState } from "react";
import type { SessionCardData, SessionDashboardApi } from "../api/session-api.js";
import iconBlack from "../assets-icon-black.svg";
import { MessageTimeline, type TimelineMessage } from "./MessageTimeline.js";
import { ModelPicker } from "./ModelPicker.js";
import { PromptComposer, type ComposerAttachment } from "./PromptComposer.js";
import "./session-dashboard.css";

export interface SessionDashboardProps {
  readonly api: SessionDashboardApi;
}

type SortMode = "recent" | "name" | "cwd";

export function SessionDashboard({ api }: SessionDashboardProps) {
  const [sessions, setSessions] = useState<readonly SessionCardData[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
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
    if (!activeSessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const messages = await api.getMessages(activeSessionId);
        if (cancelled) return;
        setMessagesBySession((current) => ({ ...current, [activeSessionId]: messages.map(toTimelineMessage) }));
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      }
    })();
    return () => { cancelled = true; };
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

  async function renameActive() {
    if (!activeSession) return;
    const name = window.prompt("New session name", activeSession.sessionName ?? "");
    if (name === null) return;
    await api.renameSession(activeSession.id, name);
    setSessions((current) => current.map((session) => session.id === activeSession.id ? { ...session, sessionName: name } : session));
  }

  async function deleteActive() {
    if (!activeSession) return;
    if (!window.confirm(`Delete session ${activeSession.sessionName ?? activeSession.id}?`)) return;
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
      setMessagesBySession((current) => ({ ...current, [activeSession.id]: messages.map(toTimelineMessage) }));
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
        await deleteActive();
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
    <main className="session-dashboard">
      <aside className="session-sidebar" aria-label="Sessions">
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
          <input placeholder="Search sessions" value={query} onChange={(event) => setQuery(event.target.value)} />
          <label><input type="checkbox" checked={showPaths} onChange={(event) => setShowPaths(event.target.checked)} /> Show paths</label>
          <label><input type="checkbox" checked={namedOnly} onChange={(event) => setNamedOnly(event.target.checked)} /> Named only</label>
          <select aria-label="Sort sessions" value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
            <option value="recent">Recent</option>
            <option value="name">Name</option>
            <option value="cwd">CWD</option>
          </select>
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
                <strong>{session.sessionName ?? session.id}</strong>
                <span>{session.status}</span>
                <small>{showPaths ? session.cwd : basename(session.cwd)}</small>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="active-session" aria-label="Active session">
        {activeSession ? (
          <>
            <header>
              <h2>{activeSession.sessionName ?? activeSession.id}</h2>
              <div className="active-actions">
                <button type="button" onClick={() => void renameActive()}>Rename</button>
                <button type="button" onClick={() => void deleteActive()}>Delete</button>
              </div>
            </header>
            <dl>
              <dt>Status</dt><dd>{activeSession.status}</dd>
              <dt>CWD</dt><dd>{activeSession.cwd}</dd>
              <dt>Model</dt><dd>{activeSession.model ?? "not selected"}</dd>
              <dt>Tokens</dt><dd>{activeSession.tokenSummary ?? "n/a"}</dd>
            </dl>

            <div className="active-session-workspace">
              <MessageTimeline messages={messagesBySession[activeSession.id] ?? []} />
              <PromptComposer
                sessionId={activeSession.id}
                isStreaming={activeSession.status === "streaming"}
                steeringQueue={steeringBySession[activeSession.id] ?? []}
                followUpQueue={followUpBySession[activeSession.id] ?? []}
                fileSuggestions={["README.md", "package.json", "src/web/main.tsx", "src/server/session/session-registry.ts"]}
                commandSuggestions={["model", "settings", "tree", "compact", "session", "new"]}
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
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
