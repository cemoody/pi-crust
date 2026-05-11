export type SessionCardStatus = "idle" | "streaming" | "waiting_for_approval" | "compacting" | "retrying" | "error";

export interface SessionCardData {
  readonly id: string;
  readonly cwd: string;
  readonly sessionName?: string;
  readonly model?: string;
  readonly status: SessionCardStatus;
  readonly tokenSummary?: string;
  readonly lastActivity: number;
}

export interface NewSessionInput {
  readonly cwd: string;
  readonly sessionName?: string;
}

export interface DashboardMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "custom" | "summary";
  readonly text: string;
  readonly provider?: string;
  readonly model?: string;
  readonly stopReason?: string;
  readonly tokenUsage?: string;
  readonly cost?: string;
  readonly error?: string;
}

export interface SessionDashboardApi {
  listSessions(): Promise<readonly SessionCardData[]>;
  createSession(input: NewSessionInput): Promise<SessionCardData>;
  renameSession(sessionId: string, name: string): Promise<SessionCardData>;
  deleteSession(sessionId: string): Promise<void>;
  getMessages(sessionId: string): Promise<readonly DashboardMessage[]>;
  prompt(sessionId: string, text: string): Promise<readonly DashboardMessage[]>;
  bash(sessionId: string, command: string, includeInContext: boolean): Promise<readonly DashboardMessage[]>;
  abort(sessionId: string): Promise<void>;
}
