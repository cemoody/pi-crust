import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { WireMessage } from "../../shared/protocol.js";
import type { DashboardConfigurationData, DashboardMessage, DashboardToolDetails, SessionCardData, SessionDashboardApi, SessionTreeData } from "../api/session-api.js";
import iconBlack from "../assets-icon-black.svg";
import { MAX_PROMPT_CHARS } from "../../shared/limits.js";
import { BUILTIN_WUI_COMMANDS, commandSuggestionNames, resolveSlashCommand, type DynamicSlashCommand, type SlashCommandDefinition } from "../commands/slash-command-registry.js";
import { CommandHelpDialog } from "./CommandHelpDialog.js";
import { ConfigurationPanel } from "./ConfigurationPanel.js";
import { MessageTimeline, type TimelineMessage } from "./MessageTimeline.js";
import { ModelPicker } from "./ModelPicker.js";
import { PromptComposer, type ComposerAttachment } from "./PromptComposer.js";
import { SessionTree } from "./SessionTree.js";
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
  const [dynamicCommands, setDynamicCommands] = useState<readonly DynamicSlashCommand[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerQuery, setModelPickerQuery] = useState("");
  const [commandHelpOpen, setCommandHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const [treeData, setTreeData] = useState<SessionTreeData | null>(null);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  const [nameDialogValue, setNameDialogValue] = useState("");
  const [pathDialog, setPathDialog] = useState<"export" | "import" | null>(null);
  const [pathDialogValue, setPathDialogValue] = useState("");
  const [resumeOpen, setResumeOpen] = useState(false);
  const [hotkeysOpen, setHotkeysOpen] = useState(false);
  const [scopedModelsOpen, setScopedModelsOpen] = useState(false);
  const [availableModels, setAvailableModels] = useState<readonly { provider: string; id: string; name: string; available: boolean }[]>([]);
  const [scopedModelIds, setScopedModelIds] = useState<readonly string[]>([]);
  const [authOpen, setAuthOpen] = useState<"login" | "logout" | null>(null);
  const [authDialogKeys, setAuthDialogKeys] = useState<Record<string, string>>({});
  const [configuredProviders, setConfiguredProviders] = useState<readonly string[]>([]);
  const [configuration, setConfiguration] = useState<DashboardConfigurationData | null>(null);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);
  const [promptErrorBySession, setPromptErrorBySession] = useState<Record<string, string | null>>({});
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
    if (!activeSessionId || !api.getCommands) {
      setDynamicCommands([]);
      return;
    }
    let cancelled = false;
    void api.getCommands(activeSessionId).then((commands) => {
      if (!cancelled) setDynamicCommands(commands);
    }).catch(() => {
      if (!cancelled) setDynamicCommands([]);
    });
    return () => { cancelled = true; };
  }, [activeSessionId, api]);

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
  const commandDefinitions = useMemo<readonly SlashCommandDefinition[]>(() => [
    ...BUILTIN_WUI_COMMANDS,
    ...dynamicCommands.map((command) => ({
      name: command.name,
      description: command.description ?? `${command.source} command`,
      source: command.source,
      implemented: true,
    })),
  ], [dynamicCommands]);

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

  async function handleSlashCommand(name: string, argv: string) {
    const command = resolveSlashCommand(name);
    if (!command) {
      const dynamic = dynamicCommands.find((candidate) => candidate.name === name);
      if (dynamic && activeSession) {
        await handlePrompt(`/${name}${argv ? ` ${argv}` : ""}`, []);
        return;
      }
      setNotice(`Unknown slash command: /${name}`);
      return;
    }

    if (command.name === "help") {
      setCommandHelpOpen(true);
      return;
    }

    if (!activeSession) {
      setNotice("Open or create a session first to run slash commands.");
      return;
    }

    switch (command.name) {
      case "model":
        setModelPickerQuery(argv.trim());
        setModelPickerOpen(true);
        return;
      case "session":
        setSessionInfoOpen(true);
        return;
      case "new":
        await createSession();
        return;
      case "name":
        if (!argv.trim()) {
          setNameDialogValue(activeSession.sessionName ?? "");
          setNameDialogOpen(true);
          return;
        }
        await renameActiveSession(argv.trim());
        return;
      case "quit":
        beginDelete();
        return;
      case "copy":
        await copyLastAssistantMessage(activeSession.id);
        return;
      case "settings":
        await openSettings();
        return;
      case "login":
        await openAuthDialog("login");
        return;
      case "logout":
        await openAuthDialog("logout");
        return;
      case "scoped-models":
        await openScopedModels();
        return;
      case "hotkeys":
        setHotkeysOpen(true);
        return;
      case "changelog":
        setChangelogOpen(true);
        return;
      case "compact":
        await compactActiveSession(argv.trim() || undefined);
        return;
      case "export":
        if (argv.trim()) await exportActiveSession(argv.trim());
        else { setPathDialog("export"); setPathDialogValue(""); }
        return;
      case "import":
        if (argv.trim()) await importSessionFromPath(argv.trim());
        else { setPathDialog("import"); setPathDialogValue(""); }
        return;
      case "reload":
        await reloadResources();
        return;
      case "tree":
        await openTree(activeSession.id);
        return;
      case "fork":
        await openTree(activeSession.id);
        setNotice("Pick a user entry in the tree, then choose Fork.");
        return;
      case "clone":
        await cloneActiveSession(activeSession.id);
        return;
      case "resume":
        setResumeOpen(true);
        return;
      case "share":
        setNotice("/share is disabled by policy for this private WUI. Export locally with /export instead.");
        return;
      default:
        setNotice(`Command \"/${name}\" is recognised in the TUI but not yet implemented in the WUI.`);
    }
  }

  async function renameActiveSession(name: string) {
    if (!activeSession) return;
    await api.renameSession(activeSession.id, name);
    setSessions((current) => current.map((session) => session.id === activeSession.id ? { ...session, sessionName: name } : session));
  }

  async function copyLastAssistantMessage(sessionId: string) {
    const lastAssistant = [...(messagesBySession[sessionId] ?? [])].reverse().find((message) => message.role === "assistant" && message.text.trim());
    const text = lastAssistant?.text ?? (api.getLastAssistantText ? await api.getLastAssistantText(sessionId) : null);
    if (!text) {
      setNotice("No assistant message to copy yet.");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied last assistant message.");
    } catch (caught) {
      setNotice(`Failed to copy assistant message: ${errorMessage(caught)}`);
    }
  }

  async function compactActiveSession(customInstructions?: string) {
    if (!activeSession) return;
    if (!api.compact) {
      setNotice("Compaction API is not available yet.");
      return;
    }
    setSessions((current) => current.map((session) => session.id === activeSession.id ? { ...session, status: "compacting" } : session));
    try {
      const result = await api.compact(activeSession.id, customInstructions);
      appendMessage(activeSession.id, { id: `compact-${Date.now()}`, role: "summary", text: result.summary, customLabel: "Compaction summary" });
      setNotice(`Compacted session${result.tokensBefore ? ` (${result.tokensBefore} tokens before)` : ""}.`);
    } catch (caught) {
      setNotice(`Compaction failed: ${errorMessage(caught)}`);
    } finally {
      setSessions((current) => current.map((session) => session.id === activeSession.id ? { ...session, status: "idle" } : session));
    }
  }

  async function exportActiveSession(outputPath?: string) {
    if (!activeSession) return;
    if (!api.exportSession) {
      setNotice("Export API is not available yet.");
      return;
    }
    try {
      const result = await api.exportSession(activeSession.id, outputPath);
      setNotice(`Exported session to ${result.path}.`);
    } catch (caught) {
      setNotice(`Export failed: ${errorMessage(caught)}`);
    }
  }

  async function importSessionFromPath(inputPath: string) {
    if (!api.importSession) {
      setNotice("Import API is not available yet.");
      return;
    }
    try {
      const imported = await api.importSession(inputPath, cwd);
      setSessions((current) => [imported, ...current.filter((session) => session.id !== imported.id)]);
      setActiveSessionId(imported.id);
      setNotice(`Imported session from ${inputPath}.`);
    } catch (caught) {
      setNotice(`Import failed: ${errorMessage(caught)}`);
    }
  }

  async function reloadResources() {
    if (!api.reloadResources) {
      setNotice("Reload API is not available yet.");
      return;
    }
    const result = await api.reloadResources(activeSession?.id);
    setNotice(result.diagnostics?.length ? `Reloaded resources: ${result.diagnostics.join("; ")}` : "Reloaded resources.");
    if (activeSessionId && api.getCommands) {
      setDynamicCommands(await api.getCommands(activeSessionId));
    }
  }

  async function refreshConfiguration() {
    if (!api.getConfiguration) return null;
    const next = await api.getConfiguration();
    setConfiguration(next);
    setConfiguredProviders(next.authProviders.filter((provider) => provider.status !== "logged-out").map((provider) => provider.provider));
    return next;
  }

  async function openSettings() {
    await refreshConfiguration().catch((caught) => setNotice(`Failed to load configuration: ${errorMessage(caught)}`));
    setSettingsOpen(true);
  }

  async function openAuthDialog(mode: "login" | "logout") {
    await refreshConfiguration().catch(() => undefined);
    setAuthOpen(mode);
  }

  async function openScopedModels() {
    const models = api.listModels ? await api.listModels() : [];
    setAvailableModels(models);
    const persisted = api.getScopedModels ? await api.getScopedModels() : [];
    setScopedModelIds(persisted.length ? persisted : models.filter((model) => model.available).map((model) => `${model.provider}/${model.id}`));
    setScopedModelsOpen(true);
  }

  function toggleScopedModel(id: string) {
    setScopedModelIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function moveScopedModel(id: string, direction: -1 | 1) {
    setScopedModelIds((current) => {
      const index = current.indexOf(id);
      const nextIndex = index + direction;
      if (index === -1 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
      return next;
    });
  }

  async function saveScopedModels() {
    if (!api.setScopedModels) {
      setNotice("Scoped model persistence API is not available yet.");
      return;
    }
    try {
      const saved = await api.setScopedModels(scopedModelIds);
      setScopedModelIds(saved);
      setNotice(`Saved ${saved.length} scoped model${saved.length === 1 ? "" : "s"}.`);
      setScopedModelsOpen(false);
    } catch (caught) {
      setNotice(`Failed to save scoped models: ${errorMessage(caught)}`);
    }
  }

  async function saveApiKey(provider: string, apiKey: string) {
    if (!api.saveApiKey) {
      setConfiguredProviders((current) => current.includes(provider) ? current : [...current, provider]);
      setNotice(`${provider} marked configured for this WUI session.`);
      return;
    }
    try {
      setConfiguration(await api.saveApiKey(provider, apiKey));
      setConfiguredProviders((current) => current.includes(provider) ? current : [...current, provider]);
      setNotice(`${provider} API key saved.`);
    } catch (caught) {
      setNotice(`Failed to save ${provider} API key: ${errorMessage(caught)}`);
    }
  }

  async function logoutProvider(provider: string) {
    if (!api.logoutProvider) {
      setConfiguredProviders((current) => current.filter((item) => item !== provider));
      setNotice(`${provider} credentials removed from this WUI session.`);
      return;
    }
    try {
      setConfiguration(await api.logoutProvider(provider));
      setConfiguredProviders((current) => current.filter((item) => item !== provider));
      setNotice(`${provider} credentials removed.`);
    } catch (caught) {
      setNotice(`Failed to logout ${provider}: ${errorMessage(caught)}`);
    }
  }

  async function saveSetting(key: string, value: string) {
    if (!api.saveSetting) {
      setNotice(`Saving setting ${key} is not available yet.`);
      return;
    }
    try {
      setConfiguration(await api.saveSetting(key, value));
      setNotice(`Saved setting ${key}.`);
    } catch (caught) {
      setNotice(`Failed to save setting ${key}: ${errorMessage(caught)}`);
    }
  }

  async function openTree(sessionId: string) {
    if (!api.getSessionTree) {
      setNotice("Session tree API is not available yet.");
      return;
    }
    try {
      setTreeData(await api.getSessionTree(sessionId));
      setTreeOpen(true);
    } catch (caught) {
      setNotice(`Failed to load session tree: ${errorMessage(caught)}`);
    }
  }

  async function cloneActiveSession(sessionId: string) {
    if (!api.cloneSession) {
      setNotice("Clone API is not available yet.");
      return;
    }
    const cloned = await api.cloneSession(sessionId);
    setSessions((current) => [cloned, ...current.filter((session) => session.id !== cloned.id)]);
    setActiveSessionId(cloned.id);
    setNotice("Cloned to new session.");
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
    <main className={`session-dashboard ${sidebarOpen ? "" : "collapsed"}`}>
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
          <img src={iconBlack} alt="" aria-hidden="true" />
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
                commandSuggestions={commandSuggestionNames(dynamicCommands)}
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

      <CommandHelpDialog
        open={commandHelpOpen}
        commands={commandDefinitions}
        onClose={() => setCommandHelpOpen(false)}
      />

      {sessionInfoOpen && activeSession ? (
        <SimpleDialog title="Session information" onClose={() => setSessionInfoOpen(false)}>
          <dl className="session-info-list">
            <dt>ID</dt><dd><code>{activeSession.id}</code></dd>
            <dt>CWD</dt><dd>{activeSession.cwd}</dd>
            <dt>Name</dt><dd>{activeSession.sessionName ?? "Untitled session"}</dd>
            <dt>Status</dt><dd>{activeSession.status}</dd>
            <dt>Model</dt><dd>{activeSession.model ?? "unset"}</dd>
            <dt>Tokens</dt><dd>{formatStats(activeSession.stats, activeSession.tokenSummary) ?? "unknown"}</dd>
          </dl>
        </SimpleDialog>
      ) : null}

      {settingsOpen ? (
        <SimpleDialog title="Configuration" onClose={() => setSettingsOpen(false)} wide>
          <ConfigurationPanel
            authProviders={configuration?.authProviders ?? ["anthropic", "openai", "google"].map((provider) => ({ provider, status: configuredProviders.includes(provider) ? "api-key" as const : "logged-out" as const }))}
            models={configuration?.models ?? []}
            thinkingLevel={configuration?.thinkingLevel ?? "medium"}
            tools={configuration?.tools ?? []}
            settings={configuration?.settings ?? { note: "Settings API is not available yet." }}
            resources={configuration?.resources ?? []}
            packages={configuration?.packages ?? []}
            themes={configuration?.themes ?? []}
            hotkeys={configuration?.hotkeys ?? [{ action: "Send", key: "Enter" }, { action: "Help", key: "?" }]}
            versions={configuration?.versions ?? [{ name: "pi-remote-control", version: "0.0.0" }]}
            onLogin={(provider) => void openAuthDialog("login").then(() => setAuthOpen("login"))}
            onLogout={(provider) => void logoutProvider(provider)}
            onApiKey={(provider, key) => void saveApiKey(provider, key)}
            onModelSelect={(provider, modelId) => activeSession && api.setModel ? void api.setModel(activeSession.id, provider, modelId) : undefined}
            onThinkingSelect={(level) => void saveSetting("defaultThinkingLevel", level)}
            onToolToggle={(name) => setNotice(`Tool toggle for ${name} is not exposed by the Pi SDK settings API yet.`)}
            onSaveSetting={(key, value) => void saveSetting(key, value)}
            onReloadResources={() => void reloadResources()}
            onPackageInstall={(source) => setNotice(`Package install disabled for ${source}.`)}
            onPackageRemove={(source) => setNotice(`Package remove disabled for ${source}.`)}
            onThemeSelect={(name) => setNotice(`Theme ${name} support is planned.`)}
          />
        </SimpleDialog>
      ) : null}

      {treeOpen && treeData ? (
        <SimpleDialog title="Session tree" onClose={() => setTreeOpen(false)} wide>
          <SessionTree
            entries={treeData.entries}
            currentLeafId={treeData.currentLeafId}
            onNavigate={(entryId, options) => {
              if (!activeSession || !api.navigateTree) return;
              void api.navigateTree(activeSession.id, entryId, options).then((result) => {
                if (result.editorText) setNotice(`Restored prompt text: ${result.editorText}`);
                setTreeOpen(false);
              });
            }}
            onRestoreUserMessage={(text) => setNotice(`Restored prompt text: ${text}`)}
            onLabel={(entryId, label) => activeSession && api.setTreeLabel ? void api.setTreeLabel(activeSession.id, entryId, label) : setNotice("Tree labels API is not available yet.")}
            onFork={(entryId) => {
              if (!activeSession || !api.forkSession) { setNotice("Fork API is not available yet."); return; }
              void api.forkSession(activeSession.id, entryId).then((forked) => {
                setSessions((current) => [forked, ...current.filter((session) => session.id !== forked.id)]);
                setActiveSessionId(forked.id);
                setTreeOpen(false);
              });
            }}
            onClone={() => activeSession ? void cloneActiveSession(activeSession.id) : undefined}
          />
        </SimpleDialog>
      ) : null}

      {changelogOpen ? (
        <SimpleDialog title="Changelog" onClose={() => setChangelogOpen(false)}>
          <p>Changelog display is wired as a WUI command. Server-backed Pi changelog loading is planned.</p>
        </SimpleDialog>
      ) : null}

      {nameDialogOpen ? (
        <SimpleDialog title="Rename session" onClose={() => setNameDialogOpen(false)}>
          <form onSubmit={(event) => { event.preventDefault(); void renameActiveSession(nameDialogValue.trim()).then(() => setNameDialogOpen(false)); }}>
            <label>Session name <input autoFocus value={nameDialogValue} onChange={(event) => setNameDialogValue(event.target.value)} aria-label="Slash session name" /></label>
            <footer><button type="submit" className="primary">Save</button></footer>
          </form>
        </SimpleDialog>
      ) : null}

      {pathDialog ? (
        <SimpleDialog title={pathDialog === "export" ? "Export session" : "Import session"} onClose={() => setPathDialog(null)}>
          <form onSubmit={(event) => {
            event.preventDefault();
            const value = pathDialogValue.trim();
            if (pathDialog === "export") void exportActiveSession(value || undefined);
            else if (value) void importSessionFromPath(value);
            setPathDialog(null);
          }}>
            <label>{pathDialog === "export" ? "Output path (optional)" : "JSONL path"}<input autoFocus value={pathDialogValue} onChange={(event) => setPathDialogValue(event.target.value)} aria-label="Slash command path" /></label>
            <footer><button type="submit" className="primary">{pathDialog === "export" ? "Export" : "Import"}</button></footer>
          </form>
        </SimpleDialog>
      ) : null}

      {resumeOpen ? (
        <SimpleDialog title="Resume session" onClose={() => setResumeOpen(false)}>
          <ul className="resume-session-list" aria-label="Resume sessions">
            {visibleSessions.map((session) => (
              <li key={session.id}>
                <button type="button" onClick={() => { setActiveSessionId(session.id); setResumeOpen(false); }}>
                  <strong>{session.sessionName ?? "Untitled session"}</strong>
                  <span>{session.cwd}</span>
                  <code>{shortSessionId(session.id)}</code>
                </button>
              </li>
            ))}
          </ul>
        </SimpleDialog>
      ) : null}

      {hotkeysOpen ? (
        <SimpleDialog title="Keyboard shortcuts" onClose={() => setHotkeysOpen(false)}>
          <dl className="session-info-list">
            <dt>Enter</dt><dd>Send prompt or steer while streaming</dd>
            <dt>Shift+Enter</dt><dd>Insert newline</dd>
            <dt>Alt+Enter</dt><dd>Queue follow-up</dd>
            <dt>Esc</dt><dd>Abort while streaming</dd>
            <dt>?</dt><dd>Open shortcuts when focus is outside the editor</dd>
          </dl>
        </SimpleDialog>
      ) : null}

      {authOpen ? (
        <SimpleDialog title={authOpen === "login" ? "Login provider" : "Logout provider"} onClose={() => setAuthOpen(null)}>
          <ul className="resume-session-list" aria-label="Auth providers">
            {(configuration?.authProviders ?? ["anthropic", "openai", "google"].map((provider) => ({ provider, status: configuredProviders.includes(provider) ? "api-key" as const : "logged-out" as const, source: undefined }))).map((auth) => (
              <li key={auth.provider}>
                <div className="auth-provider-card">
                  <strong>{auth.provider}</strong>
                  <span>{auth.status}{auth.source ? ` (${auth.source})` : ""}</span>
                  {authOpen === "login" ? (
                    <>
                      <input aria-label={`${auth.provider} slash API key`} placeholder="API key" value={authDialogKeys[auth.provider] ?? ""} onChange={(event) => setAuthDialogKeys((current) => ({ ...current, [auth.provider]: event.target.value }))} />
                      <button type="button" onClick={() => void saveApiKey(auth.provider, authDialogKeys[auth.provider] ?? "").then(() => setAuthOpen(null))}>Save API key</button>
                    </>
                  ) : (
                    <button type="button" onClick={() => void logoutProvider(auth.provider).then(() => setAuthOpen(null))}>Logout</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </SimpleDialog>
      ) : null}

      {scopedModelsOpen ? (
        <SimpleDialog title="Scoped models" onClose={() => setScopedModelsOpen(false)}>
          <ul className="resume-session-list" aria-label="Scoped models">
            {availableModels.map((model) => {
              const id = `${model.provider}/${model.id}`;
              return (
                <li key={id}>
                  <div className="scoped-model-row">
                    <label><input type="checkbox" checked={scopedModelIds.includes(id)} disabled={!model.available} onChange={() => toggleScopedModel(id)} /> {model.name} <small>{id}</small></label>
                    <button type="button" disabled={!scopedModelIds.includes(id)} onClick={() => moveScopedModel(id, -1)}>↑</button>
                    <button type="button" disabled={!scopedModelIds.includes(id)} onClick={() => moveScopedModel(id, 1)}>↓</button>
                  </div>
                </li>
              );
            })}
          </ul>
          <p>Scoped model order: {scopedModelIds.join(", ") || "none"}</p>
          <footer><button type="button" className="primary" onClick={() => void saveScopedModels()}>Save scoped models</button></footer>
        </SimpleDialog>
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
        initialQuery={modelPickerQuery}
      />
    </main>
  );
}

function SimpleDialog({ title, children, onClose, wide = false }: { readonly title: string; readonly children: ReactNode; readonly onClose: () => void; readonly wide?: boolean }) {
  return (
    <div className="simple-dialog-backdrop" role="presentation" onClick={onClose}>
      <div className={`simple-dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button type="button" onClick={onClose} aria-label={`Close ${title}`}>×</button>
        </header>
        <div className="simple-dialog-body">{children}</div>
      </div>
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
