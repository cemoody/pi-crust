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

export interface ForkMessageOption {
  readonly entryId: string;
  readonly text: string;
}

export interface ForkSessionResult {
  readonly cancelled: boolean;
  readonly text?: string;
  readonly session: SessionCardData;
}

export interface CloneSessionResult {
  readonly cancelled: boolean;
  readonly session: SessionCardData;
}

import type { ExtensionUiResponse } from "../../shared/protocol.js";

export interface DashboardArtifact {
  readonly version?: number;
  readonly kind: "image" | "html" | "markdown" | "json" | "table" | "vega-lite" | string;
  readonly title?: string;
  readonly path?: string;
  readonly url?: string;
  readonly mimeType?: string;
  readonly html?: string;
  readonly markdown?: string;
  readonly data?: unknown;
  readonly alt?: string;
}

export interface DashboardToolDetails {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly status: "running" | "success" | "error";
  readonly output: string;
  readonly artifact?: DashboardArtifact;
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
  getForkMessages?(sessionId: string): Promise<readonly ForkMessageOption[]>;
  forkSession?(sessionId: string, entryId: string): Promise<ForkSessionResult>;
  cloneSession?(sessionId: string): Promise<CloneSessionResult>;
  getSession?(sessionId: string): Promise<SessionCardData>;
  streamEvents?(sessionId: string, onEvent: (event: unknown) => void): () => void;
  respondToExtensionUi?(sessionId: string, response: ExtensionUiResponse): Promise<void>;
  listModels?(): Promise<readonly ModelOption[]>;
  setModel?(sessionId: string, provider: string, modelId: string): Promise<SessionCardData>;
}
