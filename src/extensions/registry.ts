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

export interface RegisteredCommand extends PrcCommandContribution {
  readonly extensionId: string;
  readonly invocationName: string;
}

export interface RegisteredActivityView extends PrcActivityViewContribution {
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

export class ActivityRegistry {
  private readonly views = new Map<string, RegisteredActivityView>();

  registerView(extensionId: string, view: PrcActivityViewContribution): Disposable {
    if (this.views.has(view.id)) throw new Error(`Activity view already registered: ${view.id}`);
    const registered: RegisteredActivityView = { ...view, extensionId };
    this.views.set(view.id, registered);
    return { dispose: () => { this.views.delete(view.id); } };
  }

  list(): RegisteredActivityView[] {
    return [...this.views.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title));
  }

  get(id: string): RegisteredActivityView | undefined {
    return this.views.get(id);
  }
}

export class ServerRouteRegistry {
  private readonly routes: RegisteredServerRoute[] = [];

  register(extensionId: string, route: PrcServerRouteContribution): Disposable {
    const normalized = normalizeRoute(route);
    if (this.routes.some((existing) => existing.mount === normalized.mount && existing.extensionId === extensionId && existing.method === normalized.method && existing.path === normalized.path)) {
      throw new Error(`Server route already registered: ${normalized.method} ${extensionId}${normalized.path}`);
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

export class PrcExtensionHost implements Disposable {
  readonly commands = new CommandRegistry();
  readonly activity = new ActivityRegistry();
  readonly serverRoutes = new ServerRouteRegistry();
  readonly diagnostics: ExtensionDiagnostic[] = [];
  private readonly disposables: Disposable[] = [];

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
      server: {
        routes: {
          get: (path, handler) => route("GET", path, handler),
          post: (path, handler) => route("POST", path, handler),
          put: (path, handler) => route("PUT", path, handler),
          delete: (path, handler) => route("DELETE", path, handler),
        },
        api: {
          get: (path, handler) => apiRoute("GET", path, handler),
          post: (path, handler) => apiRoute("POST", path, handler),
          put: (path, handler) => apiRoute("PUT", path, handler),
          delete: (path, handler) => apiRoute("DELETE", path, handler),
        },
      },
    };
  }
}

export function createPrcExtensionHost(): PrcExtensionHost {
  return new PrcExtensionHost();
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
  for await (const chunk of req) raw += chunk;
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
