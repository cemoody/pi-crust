import { PROTOCOL_VERSION } from "./version.js";

export type ClientOperation =
  | { readonly op: "hello"; readonly protocolVersion: number }
  | { readonly op: "list_sessions"; readonly cwd?: string }
  | { readonly op: "new_session"; readonly cwd: string; readonly sessionName?: string; readonly model?: string }
  | { readonly op: "open_session"; readonly sessionFile: string }
  | { readonly op: "close_session"; readonly sessionId: string }
  | { readonly op: "get_state"; readonly sessionId: string }
  | { readonly op: "get_messages"; readonly sessionId: string }
  | { readonly op: "prompt"; readonly sessionId: string; readonly text: string }
  | { readonly op: "steer"; readonly sessionId: string; readonly text: string }
  | { readonly op: "follow_up"; readonly sessionId: string; readonly text: string }
  | { readonly op: "abort"; readonly sessionId: string }
  | { readonly op: "set_model"; readonly sessionId: string; readonly provider: string; readonly modelId: string }
  | { readonly op: "cycle_model"; readonly sessionId: string; readonly direction?: "forward" | "backward" }
  | { readonly op: "get_available_models" }
  | { readonly op: "set_thinking_level"; readonly sessionId: string; readonly level: ThinkingLevel }
  | { readonly op: "cycle_thinking_level"; readonly sessionId: string }
  | { readonly op: "set_session_name"; readonly sessionId: string; readonly name: string }
  | { readonly op: "get_session_stats"; readonly sessionId: string }
  | { readonly op: "get_last_assistant_text"; readonly sessionId: string }
  | { readonly op: "bash"; readonly sessionId: string; readonly command: string }
  | { readonly op: "abort_bash"; readonly sessionId: string }
  | { readonly op: "compact"; readonly sessionId: string; readonly customInstructions?: string }
  | { readonly op: "set_auto_compaction"; readonly sessionId: string; readonly enabled: boolean }
  | { readonly op: "set_auto_retry"; readonly sessionId: string; readonly enabled: boolean }
  | { readonly op: "abort_retry"; readonly sessionId: string }
  | { readonly op: "get_commands"; readonly sessionId: string }
  | { readonly op: "fork"; readonly sessionId: string; readonly entryId: string }
  | { readonly op: "clone"; readonly sessionId: string }
  | { readonly op: "get_fork_messages"; readonly sessionId: string }
  | { readonly op: "switch_session"; readonly sessionId: string; readonly sessionFile: string }
  | { readonly op: "export_html"; readonly sessionId: string; readonly outputPath?: string };

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ClientEnvelope {
  readonly id: string;
  readonly type: "client_op";
  readonly protocolVersion: number;
  readonly op: ClientOperation;
}

export type ServerEnvelope =
  | { readonly type: "hello"; readonly protocolVersion: typeof PROTOCOL_VERSION; readonly features: readonly string[] }
  | { readonly type: "response"; readonly id: string; readonly ok: true; readonly data?: unknown }
  | { readonly type: "response"; readonly id: string; readonly ok: false; readonly error: ProtocolError }
  | { readonly type: "session_event"; readonly sessionId: string; readonly event: PiWireEvent }
  | { readonly type: "session_state"; readonly sessionId: string; readonly state: unknown }
  | { readonly type: "extension_ui_request"; readonly sessionId: string; readonly request: ExtensionUiRequest };

export interface ProtocolError {
  readonly code: "bad_json" | "invalid_message" | "version_mismatch" | "unknown_session" | "internal_error";
  readonly message: string;
}

export type PiWireEvent =
  | { readonly type: "agent_start" }
  | { readonly type: "agent_end"; readonly messages?: readonly unknown[] }
  | { readonly type: "turn_start" }
  | { readonly type: "turn_end"; readonly message?: unknown; readonly toolResults?: readonly unknown[] }
  | { readonly type: "message_start"; readonly message: WireMessage }
  | { readonly type: "message_update"; readonly message: WireMessage; readonly assistantMessageEvent: AssistantMessageDelta }
  | { readonly type: "message_end"; readonly message: WireMessage }
  | { readonly type: "tool_execution_start"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown }
  | { readonly type: "tool_execution_update"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown; readonly partialResult: ToolResultLike }
  | { readonly type: "tool_execution_end"; readonly toolCallId: string; readonly toolName: string; readonly result: ToolResultLike; readonly isError: boolean }
  | { readonly type: "queue_update"; readonly steering: readonly string[]; readonly followUp: readonly string[] }
  | { readonly type: "compaction_start"; readonly reason: string }
  | { readonly type: "compaction_end"; readonly reason: string; readonly result: unknown; readonly aborted: boolean; readonly willRetry?: boolean; readonly errorMessage?: string }
  | { readonly type: "auto_retry_start"; readonly attempt: number; readonly maxAttempts: number; readonly delayMs: number; readonly errorMessage: string }
  | { readonly type: "auto_retry_end"; readonly success: boolean; readonly attempt: number; readonly finalError?: string }
  | { readonly type: "extension_error"; readonly extensionPath?: string; readonly event?: string; readonly error: string };

export type AssistantMessageDelta =
  | { readonly type: "text_delta"; readonly contentIndex?: number; readonly delta: string }
  | { readonly type: "thinking_delta"; readonly contentIndex?: number; readonly delta: string }
  | { readonly type: "toolcall_delta"; readonly contentIndex?: number; readonly delta: string }
  | { readonly type: string; readonly [key: string]: unknown };

export interface WireMessage {
  readonly role: string;
  readonly content?: unknown;
  readonly timestamp?: number;
}

export interface ToolResultLike {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly details?: Record<string, unknown>;
}

export type ExtensionUiResponse =
  | { readonly id: string; readonly value: string }
  | { readonly id: string; readonly confirmed: boolean }
  | { readonly id: string; readonly cancelled: true };

export type ExtensionUiRequest =
  | { readonly id: string; readonly method: "confirm"; readonly title: string; readonly message?: string; readonly timeout?: number }
  | { readonly id: string; readonly method: "select"; readonly title: string; readonly options: readonly string[]; readonly timeout?: number }
  | { readonly id: string; readonly method: "input"; readonly title: string; readonly placeholder?: string; readonly timeout?: number }
  | { readonly id: string; readonly method: "editor"; readonly title: string; readonly prefill?: string; readonly timeout?: number }
  | { readonly id: string; readonly method: "notify"; readonly message: string; readonly notifyType?: "info" | "warning" | "error" }
  | { readonly id: string; readonly method: "setStatus"; readonly statusKey: string; readonly statusText?: string }
  | { readonly id: string; readonly method: "setWidget"; readonly widgetKey: string; readonly widgetLines?: readonly string[]; readonly widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { readonly id: string; readonly method: "setTitle"; readonly title: string }
  | { readonly id: string; readonly method: "set_editor_text"; readonly text: string };

export function parseClientEnvelope(raw: string): ClientEnvelope | ProtocolError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { code: "bad_json", message: error instanceof Error ? error.message : "Invalid JSON" };
  }

  if (!isRecord(parsed) || parsed.type !== "client_op" || typeof parsed.id !== "string" || !isRecord(parsed.op)) {
    return { code: "invalid_message", message: "Expected client_op envelope" };
  }

  if (parsed.protocolVersion !== PROTOCOL_VERSION) {
    return {
      code: "version_mismatch",
      message: `Client protocol ${String(parsed.protocolVersion)} is incompatible with server protocol ${PROTOCOL_VERSION}; reload the app.`,
    };
  }

  return parsed as unknown as ClientEnvelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
