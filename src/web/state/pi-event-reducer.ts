import type { ExtensionUiRequest, PiWireEvent, WireMessage } from "../../shared/protocol.js";
import { truncateText } from "../../shared/truncation.js";
import { contentTextAndThinking, toolResultText } from "../../shared/wire-content.js";

import { optional } from "../../shared/util.js";
export interface WebSessionState {
  readonly status: "idle" | "running" | "compacting" | "retrying" | "error";
  readonly messages: readonly WebMessage[];
  readonly tools: Readonly<Record<string, WebToolState>>;
  readonly queues: { readonly steering: readonly string[]; readonly followUp: readonly string[] };
  readonly compaction?: { readonly active: boolean; readonly reason: string; readonly errorMessage?: string };
  readonly retry?: { readonly active: boolean; readonly attempt: number; readonly maxAttempts?: number; readonly delayMs?: number; readonly errorMessage?: string; readonly finalError?: string };
  readonly toolCallDrafts: Readonly<Record<string, string>>;
  readonly extensionUiRequests: readonly ExtensionUiRequest[];
  readonly errors: readonly string[];
}

export interface WebMessage {
  readonly role: string;
  readonly text: string;
  readonly thinking: string;
  readonly timestamp?: number;
  readonly streaming?: boolean;
}

export interface WebToolState {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
  readonly status: "running" | "success" | "error";
  readonly output: string;
  readonly truncated: boolean;
}

export const initialWebSessionState: WebSessionState = {
  status: "idle",
  messages: [],
  tools: {},
  queues: { steering: [], followUp: [] },
  toolCallDrafts: {},
  extensionUiRequests: [],
  errors: [],
};

export interface ReduceOptions {
  readonly maxToolOutputChars?: number;
}

export function reducePiEvent(
  state: WebSessionState,
  event: PiWireEvent,
  options: ReduceOptions = {},
): WebSessionState {
  const maxToolOutputChars = options.maxToolOutputChars ?? 20_000;
  switch (event.type) {
    case "agent_start":
      return { ...state, status: "running" };
    case "agent_end":
      return { ...state, status: "idle" };
    case "message_start":
      return { ...state, messages: [...state.messages, toWebMessage(event.message, true)] };
    case "message_update":
      return reduceMessageUpdate(state, event);
    case "message_end":
      return replaceLastStreamingMessage(state, { ...toWebMessage(event.message, false), streaming: false });
    case "tool_execution_start":
      return {
        ...state,
        tools: {
          ...state.tools,
          [event.toolCallId]: {
            id: event.toolCallId,
            name: event.toolName,
            args: event.args,
            status: "running",
            output: "",
            truncated: false,
          },
        },
      };
    case "tool_execution_update": {
      const output = toolResultText(event.partialResult);
      const truncated = truncateText(output, maxToolOutputChars);
      return {
        ...state,
        tools: {
          ...state.tools,
          [event.toolCallId]: {
            id: event.toolCallId,
            name: event.toolName,
            args: event.args,
            status: "running",
            output: truncated.text,
            truncated: truncated.truncated,
          },
        },
      };
    }
    case "tool_execution_end": {
      const output = toolResultText(event.result);
      const truncated = truncateText(output, maxToolOutputChars);
      const existing = state.tools[event.toolCallId];
      return {
        ...state,
        tools: {
          ...state.tools,
          [event.toolCallId]: {
            id: event.toolCallId,
            name: event.toolName,
            args: existing?.args ?? {},
            status: event.isError ? "error" : "success",
            output: truncated.text,
            truncated: truncated.truncated,
          },
        },
      };
    }
    case "queue_update":
      return { ...state, queues: { steering: [...event.steering], followUp: [...event.followUp] } };
    case "compaction_start":
      return { ...state, status: "compacting", compaction: { active: true, reason: event.reason } };
    case "compaction_end":
      return {
        ...state,
        status: event.willRetry ? "retrying" : "idle",
        compaction: {
          active: false,
          reason: event.reason,
          ...optional({ errorMessage: event.errorMessage }),
        },
      };
    case "auto_retry_start":
      return {
        ...state,
        status: "retrying",
        retry: {
          active: true,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorMessage: event.errorMessage,
        },
      };
    case "auto_retry_end":
      return {
        ...state,
        status: event.success ? "idle" : "error",
        retry: {
          active: false,
          attempt: event.attempt,
          ...optional({ finalError: event.finalError }),
        },
      };
    case "extension_error":
      return { ...state, status: "error", errors: [...state.errors, event.error] };
    default:
      return state;
  }
}

function reduceMessageUpdate(
  state: WebSessionState,
  event: Extract<PiWireEvent, { type: "message_update" }>,
): WebSessionState {
  const last = state.messages.at(-1);
  const base = last?.streaming ? last : toWebMessage(event.message, true);
  const delta = event.assistantMessageEvent;
  if (delta.type === "toolcall_delta") {
    const key = String(delta.contentIndex ?? "default");
    return {
      ...state,
      toolCallDrafts: {
        ...state.toolCallDrafts,
        [key]: `${state.toolCallDrafts[key] ?? ""}${delta.delta}`,
      },
    };
  }

  const updated: WebMessage = delta.type === "text_delta"
    ? { ...base, text: `${base.text}${delta.delta}`, streaming: true }
    : delta.type === "thinking_delta"
      ? { ...base, thinking: `${base.thinking}${delta.delta}`, streaming: true }
      : base;

  if (last?.streaming) {
    return { ...state, messages: [...state.messages.slice(0, -1), updated] };
  }
  return { ...state, messages: [...state.messages, updated] };
}

export function reduceExtensionUiRequest(state: WebSessionState, request: ExtensionUiRequest): WebSessionState {
  const withoutExisting = state.extensionUiRequests.filter((existing) => existing.id !== request.id);
  return { ...state, extensionUiRequests: [...withoutExisting, request] };
}

export function clearExtensionUiRequest(state: WebSessionState, requestId: string): WebSessionState {
  return {
    ...state,
    extensionUiRequests: state.extensionUiRequests.filter((request) => request.id !== requestId),
  };
}

function replaceLastStreamingMessage(state: WebSessionState, message: WebMessage): WebSessionState {
  const last = state.messages.at(-1);
  if (!last?.streaming) return { ...state, messages: [...state.messages, message] };
  return { ...state, messages: [...state.messages.slice(0, -1), message] };
}

function toWebMessage(message: WireMessage, streaming: boolean): WebMessage {
  const { text, thinking } = contentTextAndThinking(message.content);
  return {
    role: message.role,
    text,
    thinking,
    ...optional({ timestamp: message.timestamp }),
    streaming,
  };
}
