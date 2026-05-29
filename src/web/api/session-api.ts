export type SessionCardStatus =
  | "idle"
  | "streaming"
  | "waiting_for_approval"
  | "compacting"
  | "retrying"
  | "error"
  // Infra/lifecycle states overlaid by the API server (not pi agent states).
  // "dead": the backing pi worker process died and isn't revived yet.
  // "reviving": the server is respawning the worker from the on-disk session.
  | "dead"
  | "reviving";

/** Options accepted by api.getMessages(). The server's /messages endpoint
 *  supports a tail-windowed read so a multi-MB transcript doesn't have to
 *  ship in one shot — the pi-crust should pass `limit` on initial mount to keep
 *  page-open fast even on very long sessions. */
export interface GetMessagesOptions {
  readonly limit?: number;
  readonly before?: number;
}

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

export interface BranchMessageOption {
  readonly entryId: string;
  readonly text: string;
}

export interface BranchForkResult {
  readonly cancelled: boolean;
  readonly text?: string;
  readonly session: SessionCardData;
}

export interface BranchCloneResult {
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
  readonly artifactUrl?: string;
  readonly artifactTruncated?: boolean;
  readonly artifactFullBytes?: number;
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
  /** Base64 image bytes. Only present for inline (small) images; for larger
   *  payloads the server strips this and provides `url` instead so the
   *  /messages JSON stays small. */
  readonly data?: string;
  /** Server-hosted URL for the image bytes; preferred over `data` when set. */
  readonly url?: string;
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
  readonly summaryKind?: "branch" | "compaction";
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

export interface ExtensionCommandInfo {
  readonly id: string;
  readonly invocationName: string;
  readonly title: string;
  readonly description?: string;
  readonly slashName?: string;
  readonly extensionId: string;
}

export interface ExtensionActivityInfo {
  readonly id: string;
  readonly title: string;
  readonly order?: number;
  readonly extensionId: string;
  readonly webModuleUrl?: string;
}

export interface ExtensionSettingsSectionInfo {
  readonly id: string;
  readonly title: string;
  readonly order?: number;
  readonly description?: string;
  readonly extensionId: string;
  readonly webModuleUrl?: string;
}

export interface ExtensionRouteInfo {
  readonly method: string;
  readonly path: string;
  readonly mount?: "api" | "extension";
  readonly extensionId: string;
}

export interface ExtensionDiagnosticInfo {
  readonly extensionId: string;
  readonly level: "error" | "warning";
  readonly message: string;
}

export interface ExtensionRegistryInfo {
  readonly commands: readonly ExtensionCommandInfo[];
  readonly activities: readonly ExtensionActivityInfo[];
  /**
   * Settings sections contributed by extensions via `prc.settings.registerSection`.
   * Optional for backwards compatibility with older /api/extensions payloads.
   */
  readonly settings?: readonly ExtensionSettingsSectionInfo[];
  readonly routes: readonly ExtensionRouteInfo[];
  readonly diagnostics: readonly ExtensionDiagnosticInfo[];
}

export interface ExtensionReloadResponse {
  readonly applied: boolean;
  readonly diagnostics: readonly ExtensionDiagnosticInfo[];
  readonly extensions: ExtensionRegistryInfo;
}

export interface AppBrandingSettings {
  readonly appName: string;
  /** Image URL/data URL used for the app icon. Text/emoji glyphs are intentionally not supported. */
  readonly appIconUrl?: string;
}

export interface AuthProviderInfo {
  readonly provider: string;
  readonly configured: boolean;
  /** API-key/display name, e.g. "Anthropic" or "OpenAI". Falls back to the id. */
  readonly name?: string;
  /** Subscription label for OAuth providers, e.g. "Anthropic (Claude Pro/Max)". */
  readonly oauthName?: string;
  /** Whether this provider can be logged in via OAuth subscription. */
  readonly oauthLogin?: boolean;
  /** Whether this provider accepts API-key login. A provider can support both. */
  readonly apiKeyLogin?: boolean;
  /** OAuth providers that accept a pasted redirect URL (callback-server flow). */
  readonly usesCallbackServer?: boolean;
  /** Type of credential currently stored in auth.json for this provider, if any. */
  readonly credentialType?: "oauth" | "api_key";
  readonly source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
  readonly label?: string;
}

export type OAuthLoginEvent =
  | { readonly type: "auth"; readonly url: string; readonly instructions?: string }
  | { readonly type: "progress"; readonly message: string }
  | { readonly type: "prompt"; readonly requestId: string; readonly message: string; readonly placeholder?: string; readonly allowEmpty?: boolean }
  | { readonly type: "manualCode"; readonly requestId: string; readonly message: string }
  | { readonly type: "select"; readonly requestId: string; readonly message: string; readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }> }
  | { readonly type: "done" }
  | { readonly type: "error"; readonly message: string };

export type OAuthLoginStatus = "active" | "done" | "error" | "cancelled";

export interface OAuthLoginSnapshot {
  readonly flowId: string;
  readonly provider: string;
  readonly status: OAuthLoginStatus;
  readonly cursor: number;
  readonly events: readonly OAuthLoginEvent[];
  readonly error?: string;
}

export interface AuthProviderListResponse {
  readonly providers: readonly AuthProviderInfo[];
}

export interface AuthMutationResponse {
  readonly provider: AuthProviderInfo;
}

export interface ExtensionSettingsResponse {
  readonly packages?: readonly unknown[];
  readonly projectPackages?: readonly unknown[];
  readonly disabledExtensions?: readonly string[];
  readonly appBranding?: Partial<AppBrandingSettings>;
  readonly presentations?: { readonly templateDirs?: readonly string[] };
  readonly extensions: ExtensionRegistryInfo;
}

export interface AppBrandingInfo {
  readonly appName: string;
  /** Image URL/data URL used for the app icon. */
  readonly appIcon?: string;
}

export interface ServerInfo extends AppBrandingInfo {
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
  /** Generic host HTTP helper for web extensions. Paths are relative to pi-crust's API origin, e.g. /api/extensions/x/jobs. */
  request?<T = unknown>(path: string, options?: { readonly method?: string; readonly body?: unknown }): Promise<T>;
  getDefaultCwd?(): Promise<string>;
  /** Server-side user home directory, used as the New Session dialog default. */
  getHomeCwd?(): Promise<string | undefined>;
  /** Snapshot of the server's identity (used for the help dialog SHA). */
  getServerInfo?(): Promise<ServerInfo>;
  getExtensions?(): Promise<ExtensionRegistryInfo>;
  reloadExtensions?(): Promise<ExtensionReloadResponse>;
  getExtensionSettings?(): Promise<ExtensionSettingsResponse>;
  setExtensionEnabled?(extensionId: string, enabled: boolean): Promise<ExtensionReloadResponse>;
  setAppBranding?(branding: AppBrandingSettings): Promise<AppBrandingInfo>;
  setSetting?(key: string, value: unknown): Promise<ExtensionReloadResponse>;
  listAuthProviders?(): Promise<AuthProviderListResponse>;
  login?(provider: string, apiKey: string): Promise<AuthMutationResponse>;
  logout?(provider: string): Promise<AuthMutationResponse>;
  /** Begin an interactive OAuth ("subscription") login flow. */
  startOAuthLogin?(provider: string): Promise<OAuthLoginSnapshot>;
  /** Tail a running OAuth login flow for new events. */
  pollOAuthLogin?(flowId: string, cursor: number): Promise<OAuthLoginSnapshot>;
  /** Satisfy a pending OAuth login input request (prompt/select/manual code). */
  submitOAuthLogin?(flowId: string, requestId: string, value: string): Promise<OAuthLoginSnapshot>;
  /** Cancel a running OAuth login flow. */
  cancelOAuthLogin?(flowId: string): Promise<OAuthLoginSnapshot>;
  installExtensionPackage?(source: string): Promise<ExtensionReloadResponse>;
  removeExtensionPackage?(source: string): Promise<ExtensionReloadResponse>;
  runExtensionCommand?(extensionId: string, invocationName: string, input?: unknown): Promise<unknown>;
  listSessions(cwd?: string): Promise<readonly SessionCardData[]>;
  /** Lightweight sidebar status refresh; does not open cold sessions or fetch messages. */
  listSessionStatuses?(cwd?: string): Promise<readonly SessionCardData[]>;
  createSession(input: NewSessionInput): Promise<SessionCardData>;
  renameSession(sessionId: string, name: string): Promise<SessionCardData>;
  deleteSession(sessionId: string): Promise<void>;
  getMessages(sessionId: string, options?: GetMessagesOptions): Promise<readonly DashboardMessage[]>;
  prompt(sessionId: string, text: string, attachments?: readonly PromptAttachment[]): Promise<readonly DashboardMessage[]>;
  bash(sessionId: string, command: string, includeInContext: boolean): Promise<readonly DashboardMessage[]>;
  compact?(sessionId: string, customInstructions?: string): Promise<readonly DashboardMessage[]>;
  reloadSession?(sessionId: string): Promise<SessionCardData>;
  abort(sessionId: string): Promise<void>;
  getSession?(sessionId: string): Promise<SessionCardData>;
  streamEvents?(sessionId: string, onEvent: (event: unknown) => void): () => void;
  respondToExtensionUi?(sessionId: string, response: ExtensionUiResponse): Promise<void>;
  listModels?(): Promise<readonly ModelOption[]>;
  setModel?(sessionId: string, provider: string, modelId: string): Promise<SessionCardData>;
  cron?: CronApi;
}
