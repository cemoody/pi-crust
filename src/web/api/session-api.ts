export type SessionCardStatus = "idle" | "streaming" | "waiting_for_approval" | "compacting" | "retrying" | "error";

export interface SessionCardData {
  readonly id: string;
  readonly cwd: string;
  readonly sessionName?: string;
  readonly model?: string;
  readonly status: SessionCardStatus;
  readonly tokenSummary?: string;
  readonly stats?: SessionCardStats;
  /**
   * Timestamp of the most recent user-authored input in the session history.
   * This is distinct from lastActivity, which may include assistant/tool work
   * or adapter observation time and therefore is not stable enough for the
   * sidebar's user-recency sort.
   */
  readonly lastUserActivity?: number | null;
  /** Timestamp of the session header/creation time, used as a deterministic fallback. */
  readonly createdAt?: number | null;
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
  readonly startedAt?: number;
  readonly completedAt?: number;
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
  readonly thinking?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly stopReason?: string;
  readonly tokenUsage?: string;
  readonly cost?: string;
  readonly error?: string;
  readonly tool?: DashboardToolDetails;
  readonly images?: readonly DashboardMessageImage[];
  readonly timestamp?: number;
  readonly customType?: string;
  readonly details?: Record<string, unknown>;
}

export interface ModelOption {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly reason?: string;
}

export interface CronJobView {
  readonly id: string;
  readonly name: string;
  readonly schedule: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly enabled: boolean;
  readonly lastRun: number | null;
  readonly nextRun: number | null;
  readonly lastSessionId: string | null;
  readonly scheduleError: string | null;
}

export interface CronJobInput {
  readonly name: string;
  readonly schedule: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly enabled?: boolean;
}

export interface CronJobPatch {
  readonly name?: string;
  readonly schedule?: string;
  readonly prompt?: string;
  readonly cwd?: string;
  readonly enabled?: boolean;
}

export interface CronListResponse {
  readonly jobs: readonly CronJobView[];
  readonly filePath: string;
}

export interface CronRunResponse {
  readonly job: CronJobView;
  readonly sessionId: string;
  readonly sessionFile: string;
}

export interface CronApi {
  list(): Promise<CronListResponse>;
  create(input: CronJobInput): Promise<CronJobView>;
  update(id: string, patch: CronJobPatch): Promise<CronJobView>;
  delete(id: string): Promise<void>;
  runNow(id: string): Promise<CronRunResponse>;
}

export interface ServerInfo {
  readonly gitSha: string;
  readonly adapter: string;
  readonly projectRoot: string;
  readonly sessionRoot: string;
  readonly defaultCwd: string;
  /** Server-side user home directory (os.homedir()). Optional for older
   *  API builds and mock adapters that don't supply it. */
  readonly homeCwd?: string;
}

export interface SessionDashboardApi {
  getDefaultCwd?(): Promise<string>;
  /** Server-side user home directory, used as the New Session dialog default. */
  getHomeCwd?(): Promise<string | undefined>;
  /** Snapshot of the server's identity (used for the help dialog SHA). */
  getServerInfo?(): Promise<ServerInfo>;
  listSessions(cwd?: string): Promise<readonly SessionCardData[]>;
  /** Lightweight sidebar status refresh; does not open cold sessions or fetch messages. */
  listSessionStatuses?(cwd?: string): Promise<readonly SessionCardData[]>;
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
  cron?: CronApi;
}
