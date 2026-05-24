import { PROTOCOL_VERSION } from "../../shared/version.js";
import type { ClientEnvelope, ProtocolError, ServerEnvelope } from "../../shared/protocol.js";
import { parseClientEnvelope } from "../../shared/protocol.js";
import type { SessionRegistry } from "../session/session-registry.js";

import { optional } from "../../shared/util.js";
export type SendServerEnvelope = (envelope: ServerEnvelope) => void;

export interface ProtocolRouterOptions {
  readonly registry: SessionRegistry;
  readonly send: SendServerEnvelope;
}

export class ProtocolRouter {
  private readonly registry: SessionRegistry;
  private readonly send: SendServerEnvelope;

  constructor(options: ProtocolRouterOptions) {
    this.registry = options.registry;
    this.send = options.send;
  }

  sendHello(): void {
    this.send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      features: ["sessions", "mock-adapter", "event-fanout", "reconnect-resync"],
    });
  }

  async handleRawMessage(raw: string): Promise<void> {
    const parsed = parseClientEnvelope(raw);
    if ("code" in parsed) {
      this.sendError("unknown", parsed);
      return;
    }

    try {
      await this.handleEnvelope(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal error";
      const code = message.startsWith("Unknown session") ? "unknown_session" : "internal_error";
      this.sendError(parsed.id, { code, message });
    }
  }

  private async handleEnvelope(envelope: ClientEnvelope): Promise<void> {
    const op = envelope.op;
    switch (op.op) {
      case "hello":
        this.sendHello();
        this.sendOk(envelope.id);
        return;
      case "list_sessions":
        this.sendOk(envelope.id, await this.registry.listSessions(op.cwd));
        return;
      case "new_session": {
        const session = await this.registry.createSession({
          cwd: op.cwd,
          ...optional({ sessionName: op.sessionName }),
        });
        this.sendOk(envelope.id, await session.handle.getState());
        return;
      }
      case "open_session": {
        const session = await this.registry.openSession(op.sessionFile);
        this.sendOk(envelope.id, await session.handle.getState());
        return;
      }
      case "close_session":
        await this.registry.disposeSession(op.sessionId);
        this.sendOk(envelope.id);
        return;
      case "get_state":
        this.sendOk(envelope.id, await this.registry.getSession(op.sessionId).handle.getState());
        return;
      case "get_messages":
        this.sendOk(envelope.id, await this.registry.getSession(op.sessionId).handle.getMessages());
        return;
      case "prompt":
        await this.registry.prompt(op.sessionId, op.text);
        this.sendOk(envelope.id);
        return;
      case "abort":
        await this.registry.abort(op.sessionId);
        this.sendOk(envelope.id);
        return;
      case "set_session_name":
        this.sendOk(envelope.id, await this.registry.setSessionName(op.sessionId, op.name));
        return;
      case "get_fork_messages":
        this.sendOk(envelope.id, await this.registry.getForkMessages(op.sessionId));
        return;
      case "fork": {
        const { result, session } = await this.registry.forkSession(op.sessionId, op.entryId);
        this.sendOk(envelope.id, { ...result, session: await session.handle.getState() });
        return;
      }
      case "clone": {
        const { result, session } = await this.registry.cloneSession(op.sessionId);
        this.sendOk(envelope.id, { ...result, session: await session.handle.getState() });
        return;
      }
      default:
        this.sendError(envelope.id, {
          code: "invalid_message",
          message: `Operation is defined but not implemented by router yet: ${op.op}`,
        });
    }
  }

  private sendOk(id: string, data?: unknown): void {
    this.send(data === undefined ? { type: "response", id, ok: true } : { type: "response", id, ok: true, data });
  }

  private sendError(id: string, error: ProtocolError): void {
    this.send({ type: "response", id, ok: false, error });
  }
}
