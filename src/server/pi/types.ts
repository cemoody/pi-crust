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
  readonly lastActivity: number;
}

export interface ModelInfo {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly reason?: string;
}

export type PiEvent =
  | { readonly type: "agent_start" }
  | { readonly type: "agent_end"; readonly messages: readonly SessionMessage[] }
  | { readonly type: "message"; readonly message: SessionMessage }
  | { readonly type: "error"; readonly error: string };

export interface SessionMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly timestamp: number;
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
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<SessionState>;
  subscribe(listener: PiEventListener): Unsubscribe;
  dispose(): Promise<void>;
}

export interface PiAdapter {
  createSession(options: CreateSessionOptions): Promise<PiSessionHandle>;
  openSession(options: OpenSessionOptions): Promise<PiSessionHandle>;
  listSessions(cwd?: string): Promise<readonly SessionListItem[]>;
  listModels(): Promise<readonly ModelInfo[]>;
}
