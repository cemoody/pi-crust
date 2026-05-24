import path from "node:path";
import type http from "node:http";
import type {
  Disposable,
  PrcActivityViewContribution,
  PrcCommandContribution,
  PrcExtensionContext,
  PrcExtensionFactory,
  PrcServerRouteContribution,
  PrcServerRouteHandler,
  PrcServerRouteMount,
  PrcServerRouteRequest,
  PrcServerRouteResponse,
  PrcJobContribution,
  PrcSessionsApi,
  PrcSettingsSectionContribution,
} from "./api.js";

export interface ExtensionDiagnostic {
  readonly extensionId: string;
  readonly level: "error" | "warning";
  readonly message: string;
}

export interface ActivateExtensionInput {
  readonly id: string;
  readonly factory: PrcExtensionFactory;
}

export interface ExtensionWebAsset {
  readonly extensionId: string;
  readonly filePath: string;
  readonly urlPath: string;
}

export interface PrcExtensionHostOptions {
  readonly dataDir?: string;
  readonly sessions?: PrcSessionsApi;
  readonly configDir?: string;
}

export interface RegisteredCommand extends PrcCommandContribution {
  readonly extensionId: string;
  readonly invocationName: string;
}

export interface RegisteredActivityView extends PrcActivityViewContribution {
  readonly extensionId: string;
}

export interface RegisteredSettingsSection extends PrcSettingsSectionContribution {
  readonly extensionId: string;
}

export interface RegisteredServerRoute extends PrcServerRouteContribution {
  readonly extensionId: string;
  readonly mount: PrcServerRouteMount;
}

export class CommandRegistry {
  private readonly commands = new Map<string, RegisteredCommand>();
  private readonly slashCommands = new Map<string, RegisteredCommand>();

  register(extensionId: string, command: PrcCommandContribution): Disposable {
    const invocationName = this.allocateInvocationName(command.id);
    const registered: RegisteredCommand = { ...command, extensionId, invocationName };
    this.commands.set(invocationName, registered);
    if (command.slashName && !this.slashCommands.has(command.slashName)) this.slashCommands.set(command.slashName, registered);
    return { dispose: () => {
      this.commands.delete(invocationName);
      if (command.slashName && this.slashCommands.get(command.slashName) === registered) this.slashCommands.delete(command.slashName);
    } };
  }

  list(): RegisteredCommand[] {
    return [...this.commands.values()].sort((a, b) => a.invocationName.localeCompare(b.invocationName));
  }

  get(invocationName: string): RegisteredCommand | undefined {
    return this.commands.get(invocationName);
  }

  getSlashCommand(slashName: string): RegisteredCommand | undefined {
    return this.slashCommands.get(slashName);
  }

  async run(invocationName: string, input?: unknown): Promise<unknown> {
    const command = this.commands.get(invocationName);
    if (!command) throw new Error(`Command not found: ${invocationName}`);
    return command.run(input);
  }

  private allocateInvocationName(id: string): string {
    if (!this.commands.has(id)) return id;
    let suffix = 1;
    while (this.commands.has(`${id}:${suffix}`)) suffix += 1;
    return `${id}:${suffix}`;
  }
}

/**
 * Generic ordered-by-(order,title) registry, shared by the activity-view and
 * settings-section hosts. Both contributions are { id, title, order? } and
 * exactly de-duplicated by id, so the storage + list/get behavior is
 * identical; only the user-facing register method name differs (registerView
 * vs. register), which is provided by the small wrapper classes below.
 */
class IdSortedRegistry<
  TContribution extends { readonly id: string; readonly title: string; readonly order?: number },
  TStored extends TContribution & { readonly extensionId: string },
> {
  private readonly items = new Map<string, TStored>();
  constructor(private readonly kind: string) {}

  protected put(extensionId: string, contribution: TContribution): Disposable {
    if (this.items.has(contribution.id)) throw new Error(`${this.kind} already registered: ${contribution.id}`);
    const stored = { ...contribution, extensionId } as TStored;
    this.items.set(contribution.id, stored);
    return { dispose: () => { this.items.delete(contribution.id); } };
  }

  list(): TStored[] {
    return [...this.items.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title));
  }

  get(id: string): TStored | undefined {
    return this.items.get(id);
  }
}

export class ActivityRegistry extends IdSortedRegistry<PrcActivityViewContribution, RegisteredActivityView> {
  constructor() { super("Activity view"); }
  registerView(extensionId: string, view: PrcActivityViewContribution): Disposable {
    return this.put(extensionId, view);
  }
}

export class SettingsRegistry extends IdSortedRegistry<PrcSettingsSectionContribution, RegisteredSettingsSection> {
  constructor() { super("Settings section"); }
  register(extensionId: string, section: PrcSettingsSectionContribution): Disposable {
    return this.put(extensionId, section);
  }
}

export class ServerRouteRegistry {
  private readonly routes: RegisteredServerRoute[] = [];

  register(extensionId: string, route: PrcServerRouteContribution): Disposable {
    const normalized = normalizeRoute(route);
    const duplicate = this.routes.some((existing) => existing.mount === normalized.mount
      && existing.method === normalized.method
      && existing.path === normalized.path
      && (normalized.mount === "api" || existing.extensionId === extensionId));
    if (duplicate) {
      throw new Error(`Server route already registered: ${normalized.method} ${normalized.mount === "api" ? "api" : extensionId}${normalized.path}`);
    }
    const registered: RegisteredServerRoute = { ...normalized, extensionId };
    this.routes.push(registered);
    return { dispose: () => {
      const index = this.routes.indexOf(registered);
      if (index >= 0) this.routes.splice(index, 1);
    } };
  }

  list(): RegisteredServerRoute[] {
    return [...this.routes];
  }

  async dispatch(req: http.IncomingMessage, url: URL): Promise<PrcServerRouteResponse | undefined> {
    const match = this.match(req.method ?? "GET", url.pathname);
    if (!match) return undefined;
    const request = createRouteRequest(req, url, match.params);
    const result = await match.route.handler(request);
    return normalizeRouteResponse(result);
  }

  private match(method: string, pathname: string): { route: RegisteredServerRoute; params: Record<string, string> } | undefined {
    const normalizedMethod = method.toUpperCase();
    const apiRoute = this.routes
      .filter((route) => route.mount === "api" && route.method === normalizedMethod)
      .map((route) => ({ route, params: matchRoutePath(route.path, pathname) }))
      .find((candidate): candidate is { route: RegisteredServerRoute; params: Record<string, string> } => candidate.params !== undefined);
    if (apiRoute) return apiRoute;

    const prefix = "/api/extensions/";
    if (!pathname.startsWith(prefix)) return undefined;
    const rest = pathname.slice(prefix.length);
    const slash = rest.indexOf("/");
    const extensionId = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
    const routePath = slash === -1 ? "/" : rest.slice(slash);
    return this.routes
      .filter((route) => route.mount === "extension" && route.extensionId === extensionId && route.method === normalizedMethod)
      .map((route) => ({ route, params: matchRoutePath(route.path, routePath) }))
      .find((candidate): candidate is { route: RegisteredServerRoute; params: Record<string, string> } => candidate.params !== undefined);
  }
}

const EXTENSION_ROUTE_JSON_MAX_BYTES = 1024 * 1024;

export class PrcExtensionHost implements Disposable {
  readonly commands = new CommandRegistry();
  readonly activity = new ActivityRegistry();
  readonly settings = new SettingsRegistry();
  readonly serverRoutes = new ServerRouteRegistry();
  readonly diagnostics: ExtensionDiagnostic[] = [];
  private readonly disposables: Disposable[] = [];
  private readonly webAssets = new Map<string, ExtensionWebAsset>();
  private readonly options: PrcExtensionHostOptions;
  private readonly assetVersion: string;

  constructor(options: PrcExtensionHostOptions = {}) {
    this.options = options;
    this.assetVersion = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  registerWebAsset(extensionId: string, filePath: string): ExtensionWebAsset {
    const asset = { extensionId, filePath, urlPath: `/api/extensions/${encodeURIComponent(extensionId)}/assets/${encodeURIComponent(path.basename(filePath))}?v=${encodeURIComponent(this.assetVersion)}` };
    this.webAssets.set(extensionId, asset);
    return asset;
  }

  getWebAsset(extensionId: string): ExtensionWebAsset | undefined {
    return this.webAssets.get(extensionId);
  }

  listWebAssets(): ExtensionWebAsset[] {
    return [...this.webAssets.values()];
  }

  async activate(input: ActivateExtensionInput): Promise<void> {
    const extensionDisposables: Disposable[] = [];
    const track = (disposable: Disposable): Disposable => {
      extensionDisposables.push(disposable);
      this.disposables.push(disposable);
      return disposable;
    };
    const context = this.createContext(input.id, track);
    try {
      const returned = await input.factory(context);
      if (returned) track(returned);
    } catch (error) {
      for (const disposable of extensionDisposables.reverse()) await disposable.dispose();
      this.diagnostics.push({ extensionId: input.id, level: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async activateAll(inputs: readonly ActivateExtensionInput[]): Promise<void> {
    for (const input of inputs) await this.activate(input);
  }

  async dispose(): Promise<void> {
    const disposables = this.disposables.splice(0).reverse();
    for (const disposable of disposables) await disposable.dispose();
  }

  private createContext(extensionId: string, track: (disposable: Disposable) => Disposable): PrcExtensionContext {
    const route = (method: string, path: string, handler: PrcServerRouteHandler) => track(this.serverRoutes.register(extensionId, { method, path, handler, mount: "extension" }));
    const apiRoute = (method: string, path: string, handler: PrcServerRouteHandler) => track(this.serverRoutes.register(extensionId, { method, path, handler, mount: "api" }));
    return {
      extensionId,
      commands: { register: (command) => track(this.commands.register(extensionId, command)) },
      activity: { registerView: (view) => track(this.activity.registerView(extensionId, view)) },
      settings: { registerSection: (section) => track(this.settings.register(extensionId, section)) },
      storage: { dataFile: (relativePath) => resolveExtensionDataFile(this.options.dataDir, extensionId, relativePath) },
      ...(this.options.configDir === undefined ? {} : { configDir: this.options.configDir }),
      jobs: { register: (job) => track(createStartedJobDisposable(extensionId, job, this.diagnostics)) },
      sessions: createExtensionSessionsApi(this.options.sessions),
      server: {
        routes: {
          get: (path, handler) => route("GET", path, handler),
          post: (path, handler) => route("POST", path, handler),
          put: (path, handler) => route("PUT", path, handler),
          patch: (path, handler) => route("PATCH", path, handler),
          delete: (path, handler) => route("DELETE", path, handler),
        },
        api: {
          get: (path, handler) => apiRoute("GET", path, handler),
          post: (path, handler) => apiRoute("POST", path, handler),
          put: (path, handler) => apiRoute("PUT", path, handler),
          patch: (path, handler) => apiRoute("PATCH", path, handler),
          delete: (path, handler) => apiRoute("DELETE", path, handler),
        },
      },
    };
  }
}

export function createPrcExtensionHost(options: PrcExtensionHostOptions = {}): PrcExtensionHost {
  return new PrcExtensionHost(options);
}

function resolveExtensionDataFile(dataDir: string | undefined, extensionId: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("Extension storage paths must be relative");
  const root = path.resolve(dataDir ?? path.join(process.cwd(), ".pi-crust-data"), "extensions", extensionId);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Extension storage path escapes extension data directory");
  return resolved;
}

function createExtensionSessionsApi(sessions: PrcSessionsApi | undefined): PrcSessionsApi {
  if (!sessions) return { create: async () => { throw new Error("Extension session API is not configured"); } };
  return {
    ...sessions,
    createAndPrompt: sessions.createAndPrompt ?? (async (input) => {
      if (!sessions.prompt) throw new Error("Extension session prompt API is not configured");
      const session = await sessions.create(input);
      const sessionId = extractSessionId(session);
      await sessions.prompt(sessionId, input.prompt);
      return session;
    }),
  };
}

function extractSessionId(session: unknown): string {
  if (typeof session === "object" && session !== null && "id" in session && typeof (session as { id?: unknown }).id === "string") {
    return (session as { id: string }).id;
  }
  throw new Error("Extension session create result did not include an id");
}

function createStartedJobDisposable(extensionId: string, job: PrcJobContribution, diagnostics: ExtensionDiagnostic[]): Disposable {
  let stopped = false;
  void Promise.resolve(job.start()).catch((error: unknown) => {
    diagnostics.push({ extensionId, level: "error", message: error instanceof Error ? error.message : String(error) });
  });
  return { dispose: async () => {
    if (stopped) return;
    stopped = true;
    await job.stop?.();
  } };
}

function normalizeRoute(route: PrcServerRouteContribution): PrcServerRouteContribution & { mount: PrcServerRouteMount } {
  return { ...route, method: route.method.toUpperCase(), path: route.path.startsWith("/") ? route.path : `/${route.path}`, mount: route.mount ?? "extension" };
}

function normalizeRouteResponse(result: unknown): PrcServerRouteResponse {
  if (typeof result === "object" && result !== null && ("body" in result || "status" in result || "headers" in result)) {
    return result as PrcServerRouteResponse;
  }
  return { status: 200, body: result };
}

function createRouteRequest(req: http.IncomingMessage, url: URL, params: Record<string, string>): PrcServerRouteRequest {
  let jsonPromise: Promise<unknown> | undefined;
  return {
    req,
    url,
    params,
    json: async <T>() => {
      jsonPromise ??= readJson(req);
      return jsonPromise as Promise<T>;
    },
  };
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += String(chunk);
    if (Buffer.byteLength(raw, "utf8") > EXTENSION_ROUTE_JSON_MAX_BYTES) {
      throw new Error(`Extension route JSON body exceeds ${EXTENSION_ROUTE_JSON_MAX_BYTES} bytes`);
    }
  }
  if (!raw.trim()) return undefined;
  return JSON.parse(raw);
}

function matchRoutePath(pattern: string, actual: string): Record<string, string> | undefined {
  const patternParts = trimSlashes(pattern).split("/").filter(Boolean);
  const actualParts = trimSlashes(actual).split("/").filter(Boolean);
  if (patternParts.length !== actualParts.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index]!;
    const actualPart = actualParts[index]!;
    if (patternPart.startsWith(":")) params[patternPart.slice(1)] = decodeURIComponent(actualPart);
    else if (patternPart !== actualPart) return undefined;
  }
  return params;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}
