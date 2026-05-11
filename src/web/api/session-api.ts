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
  readonly timestamp?: number;
}

export interface ModelOption {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly reason?: string;
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
}
