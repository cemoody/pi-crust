import type { PrcExtensionHost } from "./registry.js";

export interface SerializedExtensionRegistry {
  readonly commands: readonly {
    readonly id: string;
    readonly invocationName: string;
    readonly title: string;
    readonly description?: string;
    readonly slashName?: string;
    readonly extensionId: string;
  }[];
  readonly activities: readonly {
    readonly id: string;
    readonly title: string;
    readonly order?: number;
    readonly extensionId: string;
    readonly webModuleUrl?: string;
  }[];
  readonly settings: readonly {
    readonly id: string;
    readonly title: string;
    readonly order?: number;
    readonly description?: string;
    readonly extensionId: string;
    readonly webModuleUrl?: string;
  }[];
  readonly routes: readonly {
    readonly method: string;
    readonly path: string;
    readonly mount?: "api" | "extension";
    readonly extensionId: string;
  }[];
  readonly diagnostics: readonly {
    readonly extensionId: string;
    readonly level: "error" | "warning";
    readonly message: string;
  }[];
}

export function serializeExtensions(extensions: PrcExtensionHost | undefined): SerializedExtensionRegistry {
  if (!extensions) return { commands: [], activities: [], settings: [], routes: [], diagnostics: [] };
  return {
    commands: extensions.commands.list().map((command) => ({
      id: command.id,
      invocationName: command.invocationName,
      title: command.title,
      ...(command.description === undefined ? {} : { description: command.description }),
      ...(command.slashName === undefined ? {} : { slashName: command.slashName }),
      extensionId: command.extensionId,
    })),
    activities: extensions.activity.list().map((view) => ({
      id: view.id,
      title: view.title,
      ...(view.order === undefined ? {} : { order: view.order }),
      extensionId: view.extensionId,
      ...(extensions.getWebAsset(view.extensionId)?.urlPath === undefined ? {} : { webModuleUrl: extensions.getWebAsset(view.extensionId)!.urlPath }),
    })),
    settings: extensions.settings.list().map((section) => ({
      id: section.id,
      title: section.title,
      ...(section.order === undefined ? {} : { order: section.order }),
      ...(section.description === undefined ? {} : { description: section.description }),
      extensionId: section.extensionId,
      ...(extensions.getWebAsset(section.extensionId)?.urlPath === undefined ? {} : { webModuleUrl: extensions.getWebAsset(section.extensionId)!.urlPath }),
    })),
    routes: extensions.serverRoutes.list().map((route) => ({
      method: route.method,
      path: route.path,
      mount: route.mount,
      extensionId: route.extensionId,
    })),
    diagnostics: extensions.diagnostics,
  };
}
