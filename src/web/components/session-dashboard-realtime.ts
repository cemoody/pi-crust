/**
 * Realtime SSE event → MessageTimeline reducer. Extracted from
 * SessionDashboard.tsx so the dashboard component itself can focus on
 * React state + layout. All exported functions are pure; the only side
 * effect is the `setMessagesBySession(...)` callback the caller passes
 * to applyRealtimeEvent (which is the dashboard's `setState`).
 */
import type { Dispatch, SetStateAction } from "react";
import { isRecord, optional } from "../../shared/util.js";
import type { WireMessage } from "../../shared/protocol.js";
import type { DashboardMessage, DashboardToolDetails } from "../api/session-api.js";
import type {
  TimelineArtifactDetails,
  TimelineArtifactRepresentation,
  TimelineMessage,
} from "./MessageTimeline.js";
import { contentTextAndThinking, extractArtifact, toolResultText } from "./session-dashboard-helpers.js";

export type MessageSetter = Dispatch<SetStateAction<Record<string, TimelineMessage[]>>>;

type LegacyMessageEvent = {
  readonly type: "message";
  readonly message: {
    readonly role: string;
    readonly content: string;
    readonly timestamp?: number;
    readonly tool?: DashboardToolDetails;
  };
};

export function applyRealtimeEvent(
  sessionId: string,
  event: Record<string, unknown>,
  setMessagesBySession: MessageSetter,
  streamDraftIds: Record<string, string>,
): boolean {
  if (event.type === "message_start" && isRecord(event.message)) {
    const message = event.message as unknown as WireMessage;
    if (message.role === "assistant") {
      const draftId = draftIdForSession(sessionId, streamDraftIds);
      setMessagesBySession((current) => ({
        ...current,
        [sessionId]: upsertTimelineMessage(current[sessionId] ?? [], wireMessageToTimeline(draftId, message, true)),
      }));
      return true;
    }
    if (message.role === "user") {
      setMessagesBySession((current) => ({
        ...current,
        [sessionId]: appendDedupeTimelineMessage(current[sessionId] ?? [], wireMessageToTimeline(`user-${message.timestamp ?? Date.now()}`, message, false)),
      }));
      return true;
    }
    // Custom messages (e.g. the @cemoody/pi-artifact `display` tool's
    // `customType: "artifact"` payload) are delivered via sendCustomMessage,
    // which emits paired message_start/message_end events with role
    // "custom". The history loader handles these on reload, but the live
    // path dropped them — so artifacts only appeared after a refresh. Render
    // on message_start and let message_end dedupe (content is identical).
    if (message.role === "custom") {
      const customId = `custom-${message.customType ?? "msg"}-${message.timestamp ?? Date.now()}`;
      setMessagesBySession((current) => ({
        ...current,
        [sessionId]: upsertTimelineMessage(current[sessionId] ?? [], wireMessageToTimeline(customId, message, false)),
      }));
      return true;
    }
  }

  if (event.type === "message_update" && isRecord(event.assistantMessageEvent)) {
    const assistantEvent = event.assistantMessageEvent;
    const deltaType = assistantEvent.type;
    const delta = assistantEvent.delta;
    if ((deltaType === "text_delta" || deltaType === "thinking_delta") && typeof delta === "string") {
      const draftId = draftIdForSession(sessionId, streamDraftIds);
      setMessagesBySession((current) => ({
        ...current,
        [sessionId]: appendAssistantDelta(current[sessionId] ?? [], draftId, deltaType, delta),
      }));
      return true;
    }
  }

  if (event.type === "message_end" && isRecord(event.message)) {
    const message = event.message as unknown as WireMessage;
    if (message.role === "assistant") {
      const draftId = streamDraftIds[sessionId] ?? draftIdForSession(sessionId, streamDraftIds);
      delete streamDraftIds[sessionId];
      setMessagesBySession((current) => ({
        ...current,
        [sessionId]: upsertTimelineMessage(current[sessionId] ?? [], wireMessageToTimeline(draftId, message, false)),
      }));
      return false;
    }
    // Reconcile the custom message rendered on message_start (same stable id
    // ⇒ upsert is a no-op replace). Keeps the artifact even if message_start
    // was missed (e.g. mid-stream subscribe).
    if (message.role === "custom") {
      const customId = `custom-${message.customType ?? "msg"}-${message.timestamp ?? Date.now()}`;
      setMessagesBySession((current) => ({
        ...current,
        [sessionId]: upsertTimelineMessage(current[sessionId] ?? [], wireMessageToTimeline(customId, message, false)),
      }));
      return true;
    }
  }

  if (event.type === "message" && isRecord(event.message)) {
    const legacy = event as LegacyMessageEvent;
    setMessagesBySession((current) => ({
      ...current,
      [sessionId]: appendDedupeTimelineMessage(current[sessionId] ?? [], legacyMessageToTimeline(legacy.message)),
    }));
    return true;
  }

  if (event.type === "tool_execution_start" && typeof event.toolCallId === "string" && typeof event.toolName === "string") {
    const toolCallId = event.toolCallId;
    const toolName = event.toolName;
    setMessagesBySession((current) => ({
      ...current,
      [sessionId]: upsertTimelineMessage(current[sessionId] ?? [], {
        id: `tool-${toolCallId}`,
        role: "tool",
        text: "",
        tool: {
          id: toolCallId,
          name: toolName,
          args: isRecord(event.args) ? event.args : {},
          status: "running",
          output: "",
          startedAt: Date.now(),
        },
      }),
    }));
    return true;
  }

  if ((event.type === "tool_execution_update" || event.type === "tool_execution_end") && typeof event.toolCallId === "string" && typeof event.toolName === "string") {
    const toolCallId = event.toolCallId;
    const toolName = event.toolName;
    const result = event.type === "tool_execution_update" ? event.partialResult : event.result;
    const artifact = extractArtifact(result);
    setMessagesBySession((current) => ({
      ...current,
      [sessionId]: upsertTimelineMessage(current[sessionId] ?? [], {
        id: `tool-${toolCallId}`,
        role: "tool",
        text: "",
        tool: {
          id: toolCallId,
          name: toolName,
          args: {},
          status: event.type === "tool_execution_end" ? (event.isError ? "error" : "success") : "running",
          output: toolResultText(result),
          ...optional({ artifact }),
          ...(event.type === "tool_execution_end" ? { completedAt: Date.now() } : {}),
        },
      }),
    }));
    return event.type === "tool_execution_update";
  }

  return false;
}

export function draftIdForSession(sessionId: string, streamDraftIds: Record<string, string>): string {
  const existing = streamDraftIds[sessionId];
  if (existing) return existing;
  const next = `assistant-stream-${sessionId}-${Date.now()}`;
  streamDraftIds[sessionId] = next;
  return next;
}

export function appendAssistantDelta(
  messages: readonly TimelineMessage[],
  draftId: string,
  deltaType: "text_delta" | "thinking_delta",
  delta: string,
): TimelineMessage[] {
  const existing = messages.find((message) => message.id === draftId);
  const base: TimelineMessage = existing ?? { id: draftId, role: "assistant", text: "", provider: "pi" };
  const updated: TimelineMessage = deltaType === "text_delta"
    ? { ...base, text: `${base.text}${delta}` }
    : { ...base, thinking: `${base.thinking ?? ""}${delta}` };
  return upsertTimelineMessage(messages, updated);
}

export function upsertTimelineMessage(messages: readonly TimelineMessage[], message: TimelineMessage): TimelineMessage[] {
  const index = messages.findIndex((existing) => existing.id === message.id);
  if (index === -1) return [...messages, message];
  return [...messages.slice(0, index), mergeTimelineMessage(messages[index]!, message), ...messages.slice(index + 1)];
}

export function mergeTimelineMessage(previous: TimelineMessage, next: TimelineMessage): TimelineMessage {
  if (previous.role === "tool" && previous.tool && next.tool) {
    return {
      ...previous,
      ...next,
      tool: {
        ...previous.tool,
        ...next.tool,
        args: Object.keys(next.tool.args).length ? next.tool.args : previous.tool.args,
      },
    };
  }
  return { ...previous, ...next };
}

export function appendDedupeTimelineMessage(messages: readonly TimelineMessage[], message: TimelineMessage): TimelineMessage[] {
  const last = messages.at(-1);
  if (last?.role === message.role && last.text === message.text) return [...messages];
  return [...messages, message];
}

export function wireMessageToTimeline(id: string, message: WireMessage, forceAssistantProvider: boolean): TimelineMessage {
  const role = timelineRole(message.role);
  const { text, thinking } = contentTextAndThinking(message.content);
  return {
    id,
    role,
    text,
    ...(thinking ? { thinking } : {}),
    ...(forceAssistantProvider || role === "assistant" ? { provider: "pi" } : {}),
    ...optional({ customType: message.customType }),
    ...extractArtifactTimeline(message.customType, message.details),
  };
}

export function extractArtifactTimeline(
  customType: string | undefined,
  details: Record<string, unknown> | undefined,
): { readonly artifact?: TimelineArtifactDetails } {
  if (customType !== "artifact" || !isRecord(details)) return {};
  const artifacts = Array.isArray(details.artifacts) ? details.artifacts : undefined;
  const artifactGroupId = typeof details.artifactGroupId === "string" ? details.artifactGroupId : undefined;
  if (!artifacts || !artifactGroupId) return {};
  return {
    artifact: {
      artifactGroupId,
      artifacts: artifacts as unknown as readonly TimelineArtifactRepresentation[],
      ...(typeof details.version === "number" ? { version: details.version } : {}),
      ...(typeof details.caption === "string" ? { caption: details.caption } : {}),
    },
  };
}

function legacyMessageToTimeline(message: LegacyMessageEvent["message"]): TimelineMessage {
  const role = timelineRole(message.role);
  return {
    id: `${message.timestamp ?? Date.now()}-${role}`,
    role,
    text: message.content,
    ...(role === "assistant" ? { provider: "pi" } : {}),
    ...optional({ tool: message.tool }),
  };
}

function timelineRole(role: string): TimelineMessage["role"] {
  if (role === "assistant" || role === "user" || role === "tool") return role;
  return "custom";
}

export function toTimelineMessage(message: DashboardMessage): TimelineMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    ...optional({ thinking: message.thinking }),
    ...optional({ provider: message.provider }),
    ...optional({ model: message.model }),
    ...optional({ stopReason: message.stopReason }),
    ...optional({ tokenUsage: message.tokenUsage }),
    ...optional({ cost: message.cost }),
    ...optional({ error: message.error }),
    ...optional({ tool: message.tool }),
    ...optional({ timestamp: message.timestamp }),
    ...optional({ customType: message.customType }),
    ...optional({ summaryKind: message.summaryKind }),
    ...extractArtifactTimeline(message.customType, message.details),
    ...(message.images && message.images.length > 0
      ? {
          images: message.images.map((image, index) => ({
            id: `${message.id}-img-${index}`,
            // Prefer the server-hosted URL (set when the server strips inline
            // base64 to keep /messages payloads small). Fall back to the
            // inline data URL for back-compat with smaller responses.
            src: image.url
              ? `${import.meta.env.VITE_PI_CRUST_API_BASE ?? ""}${image.url}`
              : `data:${image.mimeType};base64,${image.data ?? ""}`,
            alt: "image attachment",
          })),
        }
      : {}),
  };
}
