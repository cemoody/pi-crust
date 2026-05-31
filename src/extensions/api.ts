import type http from "node:http";

export interface Disposable {
  dispose(): void | Promise<void>;
}

export interface PrcCommandContribution {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly slashName?: string;
  readonly run: (input?: unknown) => unknown | Promise<unknown>;
}

export interface PrcActivityViewContribution {
  readonly id: string;
  readonly title: string;
  readonly order?: number;
  /**
   * Placeholder for the future web-extension renderer. Tests can use strings or
   * serializable values until React/web module loading is wired in.
   */
  readonly render?: unknown;
}

export interface PrcSettingsSectionContribution {
  readonly id: string;
  readonly title: string;
  readonly order?: number;
  readonly description?: string;
}

export interface PrcServerRouteRequest {
  readonly req: http.IncomingMessage;
  readonly url: URL;
  readonly params: Record<string, string>;
  json<T = unknown>(): Promise<T>;
}

export interface PrcServerRouteResponse {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}

export type PrcServerRouteHandler = (
  request: PrcServerRouteRequest,
) => unknown | PrcServerRouteResponse | Promise<unknown | PrcServerRouteResponse>;

export type PrcServerRouteMount = "extension" | "api";

export interface PrcServerRouteContribution {
  readonly method: string;
  readonly path: string;
  readonly handler: PrcServerRouteHandler;
  readonly mount?: PrcServerRouteMount;
}

export interface PrcStorageApi {
  dataFile(relativePath: string): string;
}

export interface PrcJobContribution {
  readonly id: string;
  start(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export interface PrcSessionCreateInput {
  readonly cwd: string;
  readonly sessionName?: string;
}

export interface PrcSessionPromptInput extends PrcSessionCreateInput {
  readonly prompt: string;
}

export interface PrcForkMessage {
  readonly entryId: string;
  readonly text: string;
}

export interface PrcForkSessionResult {
  readonly cancelled: boolean;
  readonly text?: string;
  readonly session: unknown;
}

export interface PrcCloneSessionResult {
  readonly cancelled: boolean;
  readonly session: unknown;
}

export interface PrcSessionsApi {
  create(input: PrcSessionCreateInput): Promise<unknown>;
  prompt?(sessionId: string, prompt: string): Promise<void>;
  createAndPrompt?(input: PrcSessionPromptInput): Promise<unknown>;
  get?(sessionId: string): Promise<unknown>;
  getForkMessages?(sessionId: string): Promise<readonly PrcForkMessage[]>;
  forkSession?(sessionId: string, entryId: string): Promise<PrcForkSessionResult>;
  cloneSession?(sessionId: string): Promise<PrcCloneSessionResult>;
}

/**
 * A single live realtime (Socket.IO) connection, scoped to one client socket.
 * Mirrors the subset of the underlying socket an extension needs: register
 * inbound event handlers, emit outbound events to THIS connection, and read a
 * stable id. The host wires teardown automatically — when the connection drops,
 * the disposer returned from `onConnection` runs and all `on(...)` handlers are
 * detached, so extensions cannot leak per-socket listeners.
 */
export interface PrcRealtimeConnection {
  /** Stable per-connection id (the Socket.IO socket id). */
  readonly id: string;
  /** Register an inbound event handler for this connection. The optional second
   *  argument is the Socket.IO ack callback when the client emits with one. */
  on(event: string, handler: (payload: unknown, ack?: (response: unknown) => void) => void): void;
  /** Emit an event to THIS connection only. */
  emit(event: string, payload: unknown): void;
}

/** Disposer returned by a connection handler; run when the connection closes. */
export type PrcRealtimeConnectionDisposer = void | (() => void);

/** Called once per new realtime connection. */
export type PrcRealtimeConnectionHandler = (
  connection: PrcRealtimeConnection,
) => PrcRealtimeConnectionDisposer;

export interface PrcRealtimeApi {
  /** Register a handler invoked for every realtime connection (including ones
   *  already open when the extension activates is NOT guaranteed; treat this as
   *  "for each new connection"). Returns a Disposable that stops future
   *  invocations and tears down currently-attached connections. */
  onConnection(handler: PrcRealtimeConnectionHandler): Disposable;
}

export interface PrcExtensionContext {
  readonly extensionId: string;
  readonly commands: {
    register(command: PrcCommandContribution): Disposable;
  };
  readonly activity: {
    registerView(view: PrcActivityViewContribution): Disposable;
  };
  readonly settings: {
    registerSection(section: PrcSettingsSectionContribution): Disposable;
  };
  readonly storage: PrcStorageApi;
  /** pi-crust config dir for the current host (used by extensions that read settings.json). */
  readonly configDir?: string;
  readonly jobs: {
    register(job: PrcJobContribution): Disposable;
  };
  readonly sessions: PrcSessionsApi;
  readonly server: {
    readonly routes: {
      get(path: string, handler: PrcServerRouteHandler): Disposable;
      post(path: string, handler: PrcServerRouteHandler): Disposable;
      put(path: string, handler: PrcServerRouteHandler): Disposable;
      patch(path: string, handler: PrcServerRouteHandler): Disposable;
      delete(path: string, handler: PrcServerRouteHandler): Disposable;
    };
    /** Built-in/server-side extensions may register stable API compatibility routes. */
    readonly api: {
      get(path: string, handler: PrcServerRouteHandler): Disposable;
      post(path: string, handler: PrcServerRouteHandler): Disposable;
      put(path: string, handler: PrcServerRouteHandler): Disposable;
      patch(path: string, handler: PrcServerRouteHandler): Disposable;
      delete(path: string, handler: PrcServerRouteHandler): Disposable;
    };
    /** Register handlers on the shared Socket.IO realtime gateway. Lets an
     *  extension own a real-time protocol (e.g. a PTY stream) without core
     *  needing to know about it. */
    readonly realtime: PrcRealtimeApi;
  };
}

export type PrcExtensionFactory = (context: PrcExtensionContext) => void | Disposable | Promise<void | Disposable>;

export interface PrcExtensionModule {
  readonly id?: string;
  readonly name?: string;
  readonly activate?: PrcExtensionFactory;
  readonly default?: PrcExtensionFactory | { activate?: PrcExtensionFactory; id?: string; name?: string };
}
