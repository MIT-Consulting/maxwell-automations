import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatEvent, ChatStatus, InputRequest, WsServerMessage } from "@lca/shared";
import { api } from "./api";
import { connectLiveSocket } from "./liveSocket";
import { coalesceTranscript } from "./normalizeEvent";
import type { ChatMessage, StoredEvent } from "./transcript-types";
import type { RunStatus } from "@lca/shared";

/** Per-chat event snapshots for instant restore when re-selecting a chat. */
const eventCache = new Map<string, Map<number, StoredEvent>>();

/** While a turn is in flight, REST-poll so a dead WS cannot freeze the transcript. */
const ACTIVE_POLL_MS = 2500;

export function chatEventToStored(e: ChatEvent): StoredEvent {
  return {
    seq: e.seq,
    eventType: e.eventType,
    payload: e.payload,
    createdAt: e.createdAt,
  };
}

export function chatStatusToRunStatus(s: ChatStatus): RunStatus {
  switch (s) {
    case "running":
      return "running";
    case "needs_input":
      return "needs_input";
    case "error":
      return "failed";
    case "idle":
      return "completed";
  }
}

export type ChatStream = {
  messages: ChatMessage[];
  chatStatus: ChatStatus;
  pendingQuestion: string | null;
  canContinue: boolean;
  error: string | null;
  /** Re-fetch snapshot over REST (call after send when WS may be stale). */
  resync: () => void;
};

function canContinueFromSession(session: {
  agentId: string | null;
  sdkRunId: string | null;
}): boolean {
  return Boolean(
    session.agentId && session.sdkRunId && !session.agentId.startsWith("bc-")
  );
}

const IDLE_STREAM: ChatStream = {
  messages: [],
  chatStatus: "idle",
  pendingQuestion: null,
  canContinue: false,
  error: null,
  resync: () => {},
};

/**
 * Owns chat conversation data: REST seed for history, then a chat-local WebSocket
 * that merges live chat_event / chat_status / chat_input_request frames for the
 * active chat. One socket at a time — when chatId changes, the old socket closes.
 * Re-seeds on reconnect / visibility resume, and polls while a turn is active so
 * mobile half-open sockets cannot freeze the UI until a hard refresh.
 */
export function useChatStream(chatId: string | null): ChatStream {
  const [bySeq, setBySeq] = useState<Map<number, StoredEvent>>(() => new Map());
  const [chatStatus, setChatStatus] = useState<ChatStatus>("idle");
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [canContinue, setCanContinue] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;

  const mergeEvent = useRef((ev: StoredEvent) => {
    setBySeq((prev) => {
      if (prev.has(ev.seq)) return prev;
      const next = new Map(prev);
      next.set(ev.seq, ev);
      return next;
    });
  });

  const applySnapshot = useCallback(
    (snapshot: Awaited<ReturnType<typeof api.getChat>>) => {
      setBySeq((prev) => {
        const next = new Map(prev);
        for (const ev of snapshot.events) {
          next.set(ev.seq, chatEventToStored(ev));
        }
        return next;
      });
      setChatStatus(snapshot.session.status);
      setCanContinue(canContinueFromSession(snapshot.session));
      if (snapshot.session.status !== "needs_input") {
        setPendingQuestion(null);
      }
    },
    []
  );

  const resync = useCallback(() => {
    const id = chatIdRef.current;
    if (!id) return;
    void api
      .getChat(id)
      .then((snapshot) => {
        if (chatIdRef.current !== id) return;
        applySnapshot(snapshot);
        setError(null);
      })
      .catch((e) => {
        if (chatIdRef.current !== id) return;
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [applySnapshot]);

  // Seed history from REST (after restoring from module cache).
  useEffect(() => {
    if (!chatId) {
      setBySeq(new Map());
      setChatStatus("idle");
      setPendingQuestion(null);
      setCanContinue(false);
      setError(null);
      return;
    }

    let active = true;
    const cached = eventCache.get(chatId);
    setBySeq(cached ? new Map(cached) : new Map());
    setChatStatus("idle");
    setPendingQuestion(null);
    setCanContinue(false);
    setError(null);

    api
      .getChat(chatId)
      .then((snapshot) => {
        if (!active) return;
        applySnapshot(snapshot);
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)));

    return () => {
      active = false;
    };
  }, [chatId, applySnapshot]);

  // Persist events to module cache whenever they change for the active chat.
  useEffect(() => {
    if (!chatId) return;
    eventCache.set(chatId, new Map(bySeq));
  }, [chatId, bySeq]);

  // Live updates over a chat-local WebSocket.
  useEffect(() => {
    if (!chatId) return;

    return connectLiveSocket({
      onOpen: () => {
        // Catch up anything published while the prior socket was dead/zombie.
        resync();
      },
      onMessage: (msg: WsServerMessage) => {
        if (!("chatId" in msg) || msg.chatId !== chatId) return;

        if (msg.type === "chat_event") {
          const e = msg.event;
          mergeEvent.current(chatEventToStored(e));
          if (e.eventType === "input.delivered") {
            setPendingQuestion(null);
          }
        } else if (msg.type === "chat_status") {
          setChatStatus(msg.status);
          if (msg.status !== "needs_input") {
            setPendingQuestion(null);
          }
        } else if (msg.type === "chat_input_request") {
          const req: InputRequest = msg.request;
          setPendingQuestion(req.status === "pending" ? req.question : null);
        }
      },
    });
  }, [chatId, resync]);

  // Safety-net poll while a turn is active (mobile zombie WS stays OPEN).
  useEffect(() => {
    if (!chatId) return;
    if (chatStatus !== "running" && chatStatus !== "needs_input") return;

    const tick = (): void => {
      if (document.visibilityState === "hidden") return;
      resync();
    };
    const poll = setInterval(tick, ACTIVE_POLL_MS);
    return () => clearInterval(poll);
  }, [chatId, chatStatus, resync]);

  const messages = useMemo(() => {
    if (chatId === null) return [];
    const normalized = coalesceTranscript(
      [...bySeq.values()].sort((a, b) => a.seq - b.seq)
    );
    return normalized.map((message) => {
      if (!message.attachments?.length) return message;
      return {
        ...message,
        attachments: message.attachments.map((attachment) => ({
          ...attachment,
          url: api.chatAttachmentUrl(chatId, attachment.id),
        })),
      };
    });
  }, [bySeq, chatId]);

  if (chatId === null) {
    return IDLE_STREAM;
  }

  return { messages, chatStatus, pendingQuestion, canContinue, error, resync };
}
