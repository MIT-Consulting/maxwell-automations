import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type RunSnapshot } from "./api";
import type { InputRequest, Run, RunEvent, WsServerMessage } from "@lca/shared";
import { connectLiveSocket } from "./liveSocket";
import { coalesceTranscript } from "./normalizeEvent";
import type { ChatMessage, StoredEvent } from "./transcript-types";

export type RunStream = {
  messages: ChatMessage[];
  runStatus: Run["status"];
  /** Full pending request (structured metadata when present); null when none. */
  pendingInput: InputRequest | null;
  /** Convenience projection of `pendingInput.question` for free-form compose. */
  pendingQuestion: string | null;
  canContinue: boolean;
  error: string | null;
  /** Re-fetch snapshot over REST (call after send when WS may be stale). */
  resync: () => void;
};

type AgentIdentity = { agentId: string | null; sdkRunId: string | null };

/** While a turn is in flight, REST-poll so a dead WS cannot freeze the transcript. */
const ACTIVE_POLL_MS = 2500;

/** Non-empty stored prompt for display; whitespace-only counts as absent. */
function displayablePrompt(prompt: string | null | undefined): string | null {
  if (typeof prompt !== "string") return null;
  if (prompt.trim().length === 0) return null;
  return prompt;
}

function isResumableAgent({ agentId, sdkRunId }: AgentIdentity): boolean {
  return Boolean(agentId && sdkRunId && !agentId.startsWith("bc-"));
}

function identityFromRun(run: RunSnapshot["run"]): AgentIdentity {
  return { agentId: run.agent_id, sdkRunId: run.sdk_run_id };
}

function identityFromEvent(ev: StoredEvent): AgentIdentity | null {
  if (ev.eventType !== "run.started" && ev.eventType !== "run.resumed") {
    return null;
  }
  try {
    const parsed = JSON.parse(ev.payload) as {
      agentId?: unknown;
      sdkRunId?: unknown;
    };
    return {
      agentId: typeof parsed.agentId === "string" ? parsed.agentId : null,
      sdkRunId: typeof parsed.sdkRunId === "string" ? parsed.sdkRunId : null,
    };
  } catch {
    return null;
  }
}

function eventToStored(e: RunEvent): StoredEvent {
  return {
    seq: e.seq,
    eventType: e.eventType,
    payload: e.payload,
    createdAt: e.createdAt,
  };
}

/**
 * Owns all run-detail data: one REST seed fetch for history, then a modal-local
 * WebSocket that merges live run_event / run_status / input_request frames for
 * this run. Events are keyed by `seq` so reconnects never duplicate bubbles.
 * Re-seeds on reconnect / visibility resume, and polls while a turn is active.
 */
export function useRunStream(runId: string): RunStream {
  const [bySeq, setBySeq] = useState<Map<number, StoredEvent>>(new Map());
  const [runStatus, setRunStatus] = useState<Run["status"]>("queued");
  const [pendingInput, setPendingInput] = useState<InputRequest | null>(null);
  const [runIdentity, setRunIdentity] = useState<AgentIdentity>({
    agentId: null,
    sdkRunId: null,
  });
  const [seededPrompt, setSeededPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runIdRef = useRef(runId);
  runIdRef.current = runId;

  const mergeEvent = useRef((ev: StoredEvent) => {
    setBySeq((prev) => {
      if (prev.has(ev.seq)) return prev;
      const next = new Map(prev);
      next.set(ev.seq, ev);
      return next;
    });
  });

  const applySnapshot = useCallback((snapshot: RunSnapshot) => {
    setBySeq((prev) => {
      const next = new Map(prev);
      for (const ev of snapshot.events) {
        next.set(ev.seq, {
          seq: ev.seq,
          eventType: ev.event_type,
          payload: ev.payload,
          createdAt: ev.created_at,
        });
      }
      return next;
    });
    setRunStatus(snapshot.run.status);
    setRunIdentity(identityFromRun(snapshot.run));
    setSeededPrompt(displayablePrompt(snapshot.run.prompt));
    const pending = snapshot.inputRequests.find((r) => r.status === "pending");
    setPendingInput(pending ?? null);
  }, []);

  const resync = useCallback(() => {
    const id = runIdRef.current;
    void api
      .getRun(id)
      .then((snapshot) => {
        if (runIdRef.current !== id) return;
        applySnapshot(snapshot);
        setError(null);
      })
      .catch((e) => {
        if (runIdRef.current !== id) return;
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [applySnapshot]);

  // Seed history from REST.
  useEffect(() => {
    let active = true;
    setBySeq(new Map());
    setRunStatus("queued");
    setPendingInput(null);
    setRunIdentity({ agentId: null, sdkRunId: null });
    setSeededPrompt(null);
    setError(null);
    api
      .getRun(runId)
      .then((snapshot) => {
        if (!active) return;
        applySnapshot(snapshot);
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      active = false;
    };
  }, [runId, applySnapshot]);

  // Live updates over a modal-local WebSocket.
  useEffect(() => {
    return connectLiveSocket({
      onOpen: () => {
        resync();
      },
      onMessage: (msg: WsServerMessage) => {
        if (!("runId" in msg) || msg.runId !== runId) return;

        if (msg.type === "run_event") {
          const e = msg.event;
          mergeEvent.current(eventToStored(e));
          if (e.eventType === "input.delivered") {
            setPendingInput(null);
          }
        } else if (msg.type === "run_status") {
          setRunStatus(msg.status);
          if (msg.status !== "needs_input") {
            setPendingInput(null);
          }
        } else if (msg.type === "input_request") {
          const req = msg.request;
          setPendingInput(req.status === "pending" ? req : null);
        }
      },
    });
  }, [runId, resync]);

  // Safety-net poll while a turn is active (mobile zombie WS stays OPEN).
  useEffect(() => {
    if (runStatus !== "running" && runStatus !== "needs_input" && runStatus !== "paused") return;

    const tick = (): void => {
      if (document.visibilityState === "hidden") return;
      resync();
    };
    const poll = setInterval(tick, ACTIVE_POLL_MS);
    return () => clearInterval(poll);
  }, [runStatus, resync]);

  const messages = useMemo(() => {
    const normalized = coalesceTranscript(
      [...bySeq.values()].sort((a, b) => a.seq - b.seq)
    );
    const withAttachments = normalized.map((message) => {
      if (!message.attachments?.length) return message;
      return {
        ...message,
        attachments: message.attachments.map((attachment) => ({
          ...attachment,
          url: api.runAttachmentUrl(runId, attachment.id),
        })),
      };
    });
    if (!seededPrompt) return withAttachments;
    const promptMessage: ChatMessage = {
      seq: 0,
      role: "user",
      title: "Prompt",
      body: seededPrompt,
      raw: seededPrompt,
    };
    return [promptMessage, ...withAttachments];
  }, [bySeq, runId, seededPrompt]);

  const canContinue = useMemo(() => {
    if (isResumableAgent(runIdentity)) return true;
    for (const ev of bySeq.values()) {
      const identity = identityFromEvent(ev);
      if (identity && isResumableAgent(identity)) return true;
    }
    return false;
  }, [bySeq, runIdentity]);

  const pendingQuestion = pendingInput?.question ?? null;

  return {
    messages,
    runStatus,
    pendingInput,
    pendingQuestion,
    canContinue,
    error,
    resync,
  };
}
