import { EventEmitter } from "node:events";
import type {
  Automation,
  ChatEvent,
  ChatSession,
  ChatStatus,
  InputRequest,
  RunEvent,
  RunStatus,
  WsServerMessage,
} from "@lca/shared";

/**
 * Sink the data layer (RunStore) writes to whenever a run event is appended or
 * a run's status changes. Kept narrow so the store has no knowledge of HTTP/WS.
 */
export type DaemonEventSink = {
  emitRunEvent(runId: string, event: RunEvent): void;
  emitRunStatus(runId: string, status: RunStatus): void;
  emitChatEvent(chatId: string, event: ChatEvent): void;
  emitChatStatus(chatId: string, status: ChatStatus): void;
  emitChatInputRequest(chatId: string, request: InputRequest): void;
  emitRunsDeleted?(runIds: string[]): void;
  emitChatSession?(chatId: string, session: ChatSession): void;
  emitChatsDeleted?(chatIds: string[]): void;
};

/**
 * Central in-process bus. The data layer pushes run events/status changes here;
 * the WebSocket server subscribes and fans messages out to connected dashboards.
 */
export class DaemonEventBus implements DaemonEventSink {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many dashboard tabs can subscribe at once; lift the default cap.
    this.emitter.setMaxListeners(100);
  }

  emitRunEvent(runId: string, event: RunEvent): void {
    this.publish({ type: "run_event", runId, event });
  }

  emitRunStatus(runId: string, status: RunStatus): void {
    this.publish({ type: "run_status", runId, status });
  }

  emitChatEvent(chatId: string, event: ChatEvent): void {
    this.publish({ type: "chat_event", chatId, event });
  }

  emitChatStatus(chatId: string, status: ChatStatus): void {
    this.publish({ type: "chat_status", chatId, status });
  }

  emitInputRequest(runId: string, request: InputRequest): void {
    this.publish({ type: "input_request", runId, request });
  }

  emitChatInputRequest(chatId: string, request: InputRequest): void {
    this.publish({ type: "chat_input_request", chatId, request });
  }

  emitAutomationEvent(
    action: "created" | "updated" | "deleted",
    id: string,
    automation?: Automation
  ): void {
    this.publish({ type: "automation_event", action, id, automation });
  }

  emitRunsDeleted(runIds: string[]): void {
    if (runIds.length === 0) return;
    this.publish({ type: "runs_deleted", runIds });
  }

  emitChatSession(chatId: string, session: ChatSession): void {
    this.publish({ type: "chat_session", chatId, session });
  }

  emitChatsDeleted(chatIds: string[]): void {
    if (chatIds.length === 0) return;
    this.publish({ type: "chats_deleted", chatIds });
  }

  publish(message: WsServerMessage): void {
    this.emitter.emit("message", message);
  }

  subscribe(listener: (message: WsServerMessage) => void): () => void {
    this.emitter.on("message", listener);
    return () => this.emitter.off("message", listener);
  }
}
