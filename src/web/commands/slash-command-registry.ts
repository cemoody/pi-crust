export type SlashCommandSource = "wui-built-in" | "pi-built-in" | "extension" | "prompt" | "skill";

export interface ParsedSlashCommand {
  readonly raw: string;
  readonly name: string;
  readonly argv: string;
}

export interface SlashCommandDefinition {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly argumentHint?: string;
  readonly source: SlashCommandSource;
  readonly implemented: boolean;
}

export interface DynamicSlashCommand {
  readonly name: string;
  readonly description?: string;
  readonly source: Exclude<SlashCommandSource, "wui-built-in" | "pi-built-in">;
}

export const BUILTIN_WUI_COMMANDS: readonly SlashCommandDefinition[] = [
  { name: "help", description: "Show available slash commands", source: "wui-built-in", implemented: true },
  { name: "model", aliases: ["models"], description: "Select model", argumentHint: "[search]", source: "pi-built-in", implemented: true },
  { name: "session", aliases: ["info"], description: "Show session information", source: "pi-built-in", implemented: true },
  { name: "new", description: "Start a new session", source: "pi-built-in", implemented: true },
  { name: "name", description: "Set session display name", argumentHint: "<name>", source: "pi-built-in", implemented: true },
  { name: "quit", aliases: ["close"], description: "Close/dispose the active WUI session", source: "pi-built-in", implemented: true },
  { name: "copy", description: "Copy the last assistant message", source: "pi-built-in", implemented: true },
  { name: "hotkeys", description: "Show keyboard shortcuts", source: "pi-built-in", implemented: true },
  { name: "settings", description: "Open settings menu", source: "pi-built-in", implemented: true },
  { name: "scoped-models", description: "Enable/disable models for cycling", source: "pi-built-in", implemented: true },
  { name: "export", description: "Export session", argumentHint: "[path]", source: "pi-built-in", implemented: true },
  { name: "import", description: "Import and resume a JSONL session", argumentHint: "<path>", source: "pi-built-in", implemented: true },
  { name: "share", description: "Share session", source: "pi-built-in", implemented: false },
  { name: "changelog", description: "Show changelog entries", source: "pi-built-in", implemented: true },
  { name: "fork", description: "Create a new fork from a previous user message", source: "pi-built-in", implemented: true },
  { name: "clone", description: "Duplicate current session at current position", source: "pi-built-in", implemented: true },
  { name: "tree", description: "Navigate session tree", source: "pi-built-in", implemented: true },
  { name: "login", description: "Configure provider authentication", source: "pi-built-in", implemented: true },
  { name: "logout", description: "Remove provider authentication", source: "pi-built-in", implemented: true },
  { name: "compact", description: "Manually compact session context", argumentHint: "[instructions]", source: "pi-built-in", implemented: true },
  { name: "resume", description: "Resume a different session", source: "pi-built-in", implemented: true },
  { name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes", source: "pi-built-in", implemented: true },
];

export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed === "/") return null;
  const withoutSlash = trimmed.slice(1);
  const spaceIndex = withoutSlash.search(/\s/);
  const name = spaceIndex === -1 ? withoutSlash : withoutSlash.slice(0, spaceIndex);
  if (!name) return null;
  const argv = spaceIndex === -1 ? "" : withoutSlash.slice(spaceIndex).trimStart();
  return { raw: trimmed, name, argv };
}

export function resolveSlashCommand(
  name: string,
  commands: readonly SlashCommandDefinition[] = BUILTIN_WUI_COMMANDS,
): SlashCommandDefinition | undefined {
  return commands.find((command) => command.name === name || command.aliases?.includes(name));
}

export function commandSuggestionNames(
  dynamicCommands: readonly DynamicSlashCommand[] = [],
  commands: readonly SlashCommandDefinition[] = BUILTIN_WUI_COMMANDS,
): readonly string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const command of [...commands, ...dynamicCommands]) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    names.push(command.name);
  }
  return names;
}
