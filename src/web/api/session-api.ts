export type SessionCardStatus = "idle" | "streaming" | "waiting_for_approval" | "compacting" | "retrying" | "error";

export interface SessionCardData {
  readonly id: string;
  readonly cwd: string;
  readonly sessionName?: string;
  readonly model?: string;
  readonly status: SessionCardStatus;
  readonly tokenSummary?: string;
  readonly stats?: SessionCardStats;
  readonly lastActivity: number;
}

export interface SessionCardStats {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cost: number;
  readonly contextTokens: number | null;
  readonly contextPercent: number | null;
  readonly contextWindow: number | null;
}

export interface NewSessionInput {
  readonly cwd: string;
  readonly sessionName?: string;
}

export interface DashboardToolDetails {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly status: "running" | "success" | "error";
  readonly output: string;
}

export interface PromptAttachment {
  readonly type: "image" | "file";
  readonly name?: string;
  readonly mimeType?: string;
  readonly data?: string;
}

export interface DashboardMessageImage {
  readonly data: string;
  readonly mimeType: string;
}

export interface DashboardMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "custom" | "summary" | "tool";
  readonly text: string;
  readonly provider?: string;
  readonly model?: string;
  readonly stopReason?: string;
  readonly tokenUsage?: string;
  readonly cost?: string;
  readonly error?: string;
  readonly tool?: DashboardToolDetails;
  readonly images?: readonly DashboardMessageImage[];
  readonly timestamp?: number;
}

export interface ModelOption {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly reason?: string;
}

export interface SlashCommandOption {
  readonly name: string;
  readonly description?: string;
  readonly source: "extension" | "prompt" | "skill";
}

export interface DashboardConfigurationData {
  readonly authProviders: readonly { readonly provider: string; readonly displayName?: string; readonly status: "logged-in" | "logged-out" | "api-key"; readonly source?: string; readonly label?: string; readonly supportsOAuth?: boolean; readonly warning?: string }[];
  readonly models: readonly ModelOption[];
  readonly thinkingLevel: string;
  readonly settings: Record<string, unknown>;
  readonly tools: readonly { readonly name: string; readonly enabled: boolean; readonly source: "built-in" | "extension" | "custom" }[];
  readonly resources: readonly { readonly kind: string; readonly name: string; readonly status: "loaded" | "error"; readonly detail?: string }[];
  readonly packages: readonly { readonly source: string; readonly resources: readonly string[] }[];
  readonly themes: readonly { readonly name: string; readonly tokens: Record<string, string> }[];
  readonly hotkeys: readonly { readonly action: string; readonly key: string }[];
  readonly versions: readonly { readonly name: string; readonly version: string }[];
}

export interface SessionTreeData {
  readonly entries: readonly {
    readonly id: string;
    readonly parentId: string | null;
    readonly role: "user" | "assistant" | "tool" | "summary" | "custom";
    readonly text: string;
    readonly label?: string;
  }[];
  readonly currentLeafId: string | null;
}

export interface SessionDashboardApi {
  getDefaultCwd?(): Promise<string>;
  listSessions(cwd?: string): Promise<readonly SessionCardData[]>;
  createSession(input: NewSessionInput): Promise<SessionCardData>;
  renameSession(sessionId: string, name: string): Promise<SessionCardData>;
  deleteSession(sessionId: string): Promise<void>;
  getMessages(sessionId: string): Promise<readonly DashboardMessage[]>;
  prompt(sessionId: string, text: string, attachments?: readonly PromptAttachment[]): Promise<readonly DashboardMessage[]>;
  bash(sessionId: string, command: string, includeInContext: boolean): Promise<readonly DashboardMessage[]>;
  abort(sessionId: string): Promise<void>;
  getSession?(sessionId: string): Promise<SessionCardData>;
  streamEvents?(sessionId: string, onEvent: (event: unknown) => void): () => void;
  listModels?(): Promise<readonly ModelOption[]>;
  setModel?(sessionId: string, provider: string, modelId: string): Promise<SessionCardData>;
  getLastAssistantText?(sessionId: string): Promise<string | null>;
  getCommands?(sessionId: string): Promise<readonly SlashCommandOption[]>;
  compact?(sessionId: string, customInstructions?: string): Promise<{ readonly summary: string; readonly tokensBefore?: number }>;
  exportSession?(sessionId: string, outputPath?: string): Promise<{ readonly path: string }>;
  importSession?(path: string, cwd?: string): Promise<SessionCardData>;
  reloadResources?(sessionId?: string): Promise<{ readonly diagnostics?: readonly string[] }>;
  getSessionTree?(sessionId: string): Promise<SessionTreeData>;
  navigateTree?(sessionId: string, entryId: string, options: { readonly summary: "none" | "default" | "custom"; readonly customInstructions?: string }): Promise<{ readonly editorText?: string }>;
  setTreeLabel?(sessionId: string, entryId: string, label: string | undefined): Promise<void>;
  forkSession?(sessionId: string, entryId: string): Promise<SessionCardData & { readonly selectedText?: string }>;
  cloneSession?(sessionId: string): Promise<SessionCardData>;
  getConfiguration?(): Promise<DashboardConfigurationData>;
  saveApiKey?(provider: string, apiKey: string): Promise<DashboardConfigurationData>;
  logoutProvider?(provider: string): Promise<DashboardConfigurationData>;
  saveSetting?(key: string, value: unknown): Promise<DashboardConfigurationData>;
  getScopedModels?(): Promise<readonly string[]>;
  setScopedModels?(modelIds: readonly string[]): Promise<readonly string[]>;
}
