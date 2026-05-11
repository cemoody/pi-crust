import type { ExtensionUiRequest, ExtensionUiResponse, PiWireEvent } from "../../shared/protocol.js";

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

export type PiEvent =
  | PiWireEvent
  | { readonly type: "agent_start" }
  | { readonly type: "agent_end"; readonly messages: readonly SessionMessage[] }
  | { readonly type: "message"; readonly message: SessionMessage }
  | { readonly type: "error"; readonly error: string }
  | { readonly type: "extension_ui_request"; readonly id: string; readonly method: ExtensionUiRequest["method"]; readonly [key: string]: unknown };

export interface SessionMessage {
  readonly role: "user" | "assistant" | "system" | "tool" | "custom";
  readonly content: string;
  readonly timestamp: number;
  readonly tool?: SessionToolDetails;
  readonly images?: readonly SessionMessageImage[];
  /** Pi `customType` for `role === "custom"` (e.g., "artifact"). */
  readonly customType?: string;
  /** Structured payload for custom messages (e.g., ArtifactMessageDetails). */
  readonly customDetails?: unknown;
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
  respondToExtensionUi?(response: ExtensionUiResponse): Promise<void>;
  subscribe(listener: PiEventListener): Unsubscribe;
  dispose(): Promise<void>;
}

export interface PiAdapter {
  createSession(options: CreateSessionOptions): Promise<PiSessionHandle>;
  openSession(options: OpenSessionOptions): Promise<PiSessionHandle>;
  listSessions(cwd?: string): Promise<readonly SessionListItem[]>;
  listModels(): Promise<readonly ModelInfo[]>;
}
