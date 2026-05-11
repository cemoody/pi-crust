export type SessionStatus = "idle" | "running" | "compacting" | "retrying" | "error";

export interface SessionListItem {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
  readonly sessionName?: string;
  readonly firstMessage?: string;
  readonly lastActivity: number;
}

export interface SessionState {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
  readonly status: SessionStatus;
  readonly sessionName?: string;
  readonly model?: string;
  readonly modelProvider?: string;
  readonly messageCount: number;
  readonly totalTokens?: number;
  readonly stats?: SessionStats;
  readonly lastActivity: number;
}

export interface SessionStats {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cost: number;
  readonly contextTokens: number | null;
  readonly contextPercent: number | null;
  readonly contextWindow: number | null;
}

export interface ModelInfo {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly reason?: string;
}

export interface AuthProviderInfo {
  readonly provider: string;
  readonly displayName?: string;
  readonly status: "logged-in" | "logged-out" | "api-key";
  readonly source?: string;
  readonly label?: string;
  readonly supportsOAuth?: boolean;
  readonly warning?: string;
}

export interface DashboardConfigurationInfo {
  readonly authProviders: readonly AuthProviderInfo[];
  readonly models: readonly ModelInfo[];
  readonly thinkingLevel: string;
  readonly settings: Record<string, unknown>;
  readonly tools: readonly { readonly name: string; readonly enabled: boolean; readonly source: "built-in" | "extension" | "custom" }[];
  readonly resources: readonly { readonly kind: string; readonly name: string; readonly status: "loaded" | "error"; readonly detail?: string }[];
  readonly packages: readonly { readonly source: string; readonly resources: readonly string[] }[];
  readonly themes: readonly { readonly name: string; readonly tokens: Record<string, string> }[];
  readonly hotkeys: readonly { readonly action: string; readonly key: string }[];
  readonly versions: readonly { readonly name: string; readonly version: string }[];
}

export type PiEvent =
  | { readonly type: "agent_start" }
  | { readonly type: "agent_end"; readonly messages: readonly SessionMessage[] }
  | { readonly type: "message"; readonly message: SessionMessage }
  | { readonly type: "error"; readonly error: string };

export interface SessionMessage {
  readonly role: "user" | "assistant" | "system" | "tool";
  readonly content: string;
  readonly timestamp: number;
  readonly tool?: SessionToolDetails;
  readonly images?: readonly SessionMessageImage[];
}

export interface SessionMessageImage {
  readonly data: string;
  readonly mimeType: string;
}

export interface PromptAttachment {
  readonly type: "image" | "file";
  readonly name?: string;
  readonly mimeType?: string;
  readonly data?: string;
}

export interface SessionToolDetails {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly status: "running" | "success" | "error";
  readonly output: string;
}

export interface SlashCommandInfo {
  readonly name: string;
  readonly description?: string;
  readonly source: "extension" | "prompt" | "skill";
}

export interface SessionTreeEntryInfo {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: "user" | "assistant" | "tool" | "summary" | "custom";
  readonly text: string;
  readonly label?: string;
}

export interface SessionTreeInfo {
  readonly entries: readonly SessionTreeEntryInfo[];
  readonly currentLeafId: string | null;
}

export interface CompactionResultInfo {
  readonly summary: string;
  readonly tokensBefore?: number;
}

export interface CreateSessionOptions {
  readonly cwd: string;
  readonly sessionName?: string;
}

export interface OpenSessionOptions {
  readonly sessionFile: string;
}

export type Unsubscribe = () => void;
export type PiEventListener = (event: PiEvent) => void;

export interface PiSessionHandle {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
  getState(): Promise<SessionState>;
  getMessages(): Promise<readonly SessionMessage[]>;
  prompt(message: string, attachments?: readonly PromptAttachment[]): Promise<void>;
  abort(): Promise<void>;
  setSessionName(name: string): Promise<SessionState>;
  setModel(provider: string, modelId: string): Promise<SessionState>;
  getLastAssistantText(): Promise<string | null>;
  getCommands(): Promise<readonly SlashCommandInfo[]>;
  compact(customInstructions?: string): Promise<CompactionResultInfo>;
  getTree(): Promise<SessionTreeInfo>;
  setTreeLabel(entryId: string, label: string | undefined): Promise<SessionTreeInfo>;
  navigateTree(entryId: string, options: { readonly summary: "none" | "default" | "custom"; readonly customInstructions?: string }): Promise<{ readonly editorText?: string; readonly tree: SessionTreeInfo }>;
  subscribe(listener: PiEventListener): Unsubscribe;
  dispose(): Promise<void>;
}

export interface PiAdapter {
  createSession(options: CreateSessionOptions): Promise<PiSessionHandle>;
  openSession(options: OpenSessionOptions): Promise<PiSessionHandle>;
  listSessions(cwd?: string): Promise<readonly SessionListItem[]>;
  listModels(): Promise<readonly ModelInfo[]>;
  getConfiguration?(): Promise<DashboardConfigurationInfo>;
  saveApiKey?(provider: string, apiKey: string): Promise<DashboardConfigurationInfo>;
  logoutProvider?(provider: string): Promise<DashboardConfigurationInfo>;
  saveSetting?(key: string, value: unknown): Promise<DashboardConfigurationInfo>;
  getScopedModels?(): Promise<readonly string[]>;
  setScopedModels?(modelIds: readonly string[]): Promise<readonly string[]>;
  reloadResources?(): Promise<readonly string[]>;
}
