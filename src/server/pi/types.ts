import type { ExtensionUiRequest, ExtensionUiResponse, PiWireEvent } from "../../shared/protocol.js";

export type SessionStatus = "idle" | "running" | "compacting" | "retrying" | "error";

export interface SessionListItem {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
  readonly sessionName?: string;
  readonly firstMessage?: string;
  readonly lastUserActivity?: number | null;
  readonly createdAt?: number | null;
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
  readonly lastUserActivity?: number | null;
  readonly createdAt?: number | null;
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
  readonly role: "user" | "assistant" | "system" | "tool" | "custom" | "summary";
  readonly content: string;
  readonly timestamp: number;
  readonly tool?: SessionToolDetails;
  readonly summaryKind?: "branch" | "compaction";
  readonly images?: readonly SessionMessageImage[];
  /** Set for custom-message entries (e.g. artifact, todo) emitted by extensions. */
  readonly customType?: string;
  /** Opaque per-customType payload. Schema is defined by the producing extension. */
  readonly details?: Record<string, unknown>;
  /** Assistant-turn stop reason, e.g. "endTurn", "toolUse", "error". */
  readonly stopReason?: string;
  /** Provider error message captured when stopReason === "error". */
  readonly errorMessage?: string;
  /** Assistant reasoning / "thinking" content, kept separate from visible text. */
  readonly thinking?: string;
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

export interface ForkMessage {
  readonly entryId: string;
  readonly text: string;
}

export interface ForkSessionResult {
  readonly cancelled: boolean;
  readonly text?: string;
}

export interface CloneSessionResult {
  readonly cancelled: boolean;
}

export interface SessionToolDetails {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly status: "running" | "success" | "error";
  readonly output: string;
  /** Epoch-ms when the toolCall was emitted (assistant turn timestamp). */
  readonly startedAt?: number;
  /** Epoch-ms when the toolResult arrived. Undefined while still running. */
  readonly completedAt?: number;
  /** Optional artifact payload extracted from the tool's result.details.
   *  Currently used by show_presentation/show_artifact to attach inline
   *  preview data so it survives a page reload. */
  readonly artifact?: unknown;
}

export interface CreateSessionOptions {
  readonly cwd: string;
  readonly sessionName?: string;
}

export interface OpenSessionOptions {
  readonly sessionFile: string;
}

export interface ReattachSessionOptions {
  readonly sessionId: string;
  readonly socketPath: string;
  readonly sessionFile: string;
  readonly cwd: string;
}

export type Unsubscribe = () => void;
export type PiEventListener = (event: PiEvent) => void;
export type SeqEventListener = (event: PiEvent, seq: number) => void;

export interface PiSessionHandle {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile: string;
  getState(): Promise<SessionState>;
  getMessages(): Promise<readonly SessionMessage[]>;
  prompt(message: string, attachments?: readonly PromptAttachment[]): Promise<void>;
  compact?(customInstructions?: string): Promise<unknown>;
  /** Restart the underlying Pi runtime for this session, preserving session file/cwd. */
  reload?(): Promise<SessionState>;
  abort(): Promise<void>;
  setSessionName(name: string): Promise<SessionState>;
  setModel(provider: string, modelId: string): Promise<SessionState>;
  getForkMessages?(): Promise<readonly ForkMessage[]>;
  fork?(entryId: string): Promise<ForkSessionResult>;
  clone?(): Promise<CloneSessionResult>;
  respondToExtensionUi?(response: ExtensionUiResponse): Promise<void>;
  subscribe(listener: PiEventListener): Unsubscribe;
  /** Optional: subscribe and receive the supervisor-assigned monotonic seq alongside each event. */
  subscribeWithSeq?(listener: SeqEventListener): Unsubscribe;
  /** RPC-shutdown the worker process. Used on explicit session delete. */
  dispose(): Promise<void>;
  /** Close the worker connection without killing it (used on API SIGTERM/SIGINT). */
  detach?(): Promise<void>;
  /**
   * Server-side observability: returns true iff this handle's underlying
   * worker connection is still open. Used by /api/health to surface broken
   * session handles before users hit them. Optional so non-RPC adapters
   * (e.g. the mock adapter in tests) can omit it.
   */
  isHealthy?(): boolean;
}

export interface PiAdapter {
  createSession(options: CreateSessionOptions): Promise<PiSessionHandle>;
  openSession(options: OpenSessionOptions): Promise<PiSessionHandle>;
  listSessions(cwd?: string): Promise<readonly SessionListItem[]>;
  listModels(): Promise<readonly ModelInfo[]>;
  /**
   * Create an independent fork of a hot source session.
   *
   * Implementations should return a new handle backed by a distinct worker/session
   * and must not mutate or replace the source handle. Adapters that do not
   * implement this fall back to the legacy session-replacement handle.fork API.
   */
  forkSession?(source: PiSessionHandle, entryId: string): Promise<{ readonly result: ForkSessionResult; readonly handle: PiSessionHandle }>;
  /** Reattach to a detached worker the API server discovered at boot. */
  reattachSession?(options: ReattachSessionOptions): Promise<PiSessionHandle>;
}
