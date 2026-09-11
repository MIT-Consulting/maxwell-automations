import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type Automation,
  type Run,
  type Workspace,
} from "./api";
import {
  legacyModelFromSelection,
  modelSelectionFromLifecyclePayload,
  type InputRequest,
  type ModelSelection,
  type RunEvent,
  type WsServerMessage,
} from "@lca/shared";
import { connectLiveSocket } from "./liveSocket";

export type DashboardData = {
  automations: Automation[];
  runs: Run[];
  workspaces: Workspace[];
  lastEventByRun: Record<string, string>;
  /** Selection recorded on `run.started` / `run.resumed` / `run.model` when present. */
  modelByRun: Record<string, ModelSelection>;
  pendingInputByRun: Record<string, InputRequest>;
  connected: boolean;
  error: string | null;
  refresh: () => void;
  /** Merge a run patch into local state (e.g. after PATCH model). */
  applyRun: (run: Run) => void;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function strField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const DISCOVERY_SKIP_CODES = new Set([
  "disabled",
  "wave-scoped",
  "source-resolved",
  "ineligible-source",
  "invalid-trigger",
]);

const DISCOVERY_FAILURE_STAGES = new Set(["spawn", "diagnosis", "briefing"]);

/**
 * Compact card-line summary for b43 recovery and b44 halt-discovery lifecycle
 * events. Returns `undefined` for other event types so callers keep generic
 * formatting. Malformed payloads for these types return a safe generic line
 * (never HTML / raw JSON).
 */
export function summarizeRecoveryDashboardEvent(
  eventType: string,
  payloadRaw: string
): string | undefined {
  const isRecovery =
    eventType === "run.pipeline-escalated" ||
    eventType === "run.pipeline-halt-unrecovered";
  const isDiscovery =
    eventType === "run.pipeline-halt-discovery-requested" ||
    eventType === "run.pipeline-halt-discovery-skipped" ||
    eventType === "run.pipeline-halt-discovery-failed" ||
    eventType === "run.pipeline-halt-discovery-action-result" ||
    eventType === "run.pipeline-halt-discovery-promoted";
  if (!isRecovery && !isDiscovery) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadRaw);
  } catch {
    parsed = undefined;
  }
  const p = asRecord(parsed);

  if (eventType === "run.pipeline-escalated") {
    const actionRaw = strField(p?.action);
    const action =
      actionRaw === "retry" || actionRaw === "skip" || actionRaw === "abort"
        ? actionRaw
        : undefined;
    if (!action) return "Pipeline escalated";

    const actorRaw = strField(p?.actor);
    const actor =
      actorRaw === "daemon" || actorRaw === "operator" ? actorRaw : undefined;
    const childRunId = strField(p?.childRunId);
    const childPart = childRunId ? ` → ${childRunId.slice(0, 8)}` : "";

    if (actor === "daemon") {
      return `Automatic ${action}${childPart}`;
    }
    if (actor === "operator") {
      return `Operator escalated with ${action}${childPart}`;
    }
    return `Pipeline escalated with ${action}${childPart}`;
  }

  if (eventType === "run.pipeline-halt-unrecovered") {
    const code = strField(p?.code);
    const detail = strField(p?.detail);
    if (!code || !detail) return "Automatic recovery declined";
    return `Automatic recovery declined (${code})`;
  }

  if (eventType === "run.pipeline-halt-discovery-requested") {
    const recoveryCode = strField(p?.recoveryCode);
    if (strField(p?.code) !== "unrecovered-halt" || !recoveryCode) {
      return "Halt discovery requested";
    }
    return `Halt discovery requested (${recoveryCode})`;
  }

  if (eventType === "run.pipeline-halt-discovery-skipped") {
    const code = strField(p?.code);
    if (!code || !DISCOVERY_SKIP_CODES.has(code)) {
      return "Halt discovery skipped";
    }
    return `Halt discovery skipped (${code})`;
  }

  if (eventType === "run.pipeline-halt-discovery-failed") {
    const stage = strField(p?.stage);
    const code = strField(p?.code);
    if (!stage || !DISCOVERY_FAILURE_STAGES.has(stage) || !code) {
      return "Halt discovery failed";
    }
    return `Halt discovery failed (${stage}/${code})`;
  }

  if (eventType === "run.pipeline-halt-discovery-action-result") {
    const outcome = strField(p?.outcome);
    const action = strField(p?.action);
    const sourceRunId = strField(p?.sourceRunId);
    if (
      (outcome !== "acted" &&
        outcome !== "refused" &&
        outcome !== "internal-failure") ||
      (action !== "retry" && action !== "skip" && action !== "abort") ||
      !sourceRunId
    ) {
      return "Halt discovery action result";
    }
    const sourceShort = sourceRunId.slice(0, 8);
    if (outcome === "acted") {
      const childRunId = strField(p?.childRunId);
      const childPart = childRunId ? ` → ${childRunId.slice(0, 8)}` : "";
      return `Discovery acted ${action}${childPart} (source ${sourceShort})`;
    }
    if (outcome === "refused") {
      const code = strField(p?.code);
      const codePart = code ? ` ${code}` : "";
      return `Discovery refused ${action}${codePart} (source ${sourceShort}; not recovered)`;
    }
    const code = strField(p?.code);
    const codePart = code ? ` ${code}` : "";
    return `Discovery internal-failure ${action}${codePart} (source ${sourceShort}; not recovered)`;
  }

  // run.pipeline-halt-discovery-promoted
  const sourceRunId = strField(p?.sourceRunId);
  const chatId = strField(p?.chatId);
  if (!sourceRunId || !chatId) {
    return "Halt discovery promoted to chat (source not escalated)";
  }
  return `Discovery → chat ${chatId.slice(0, 8)} (source ${sourceRunId.slice(0, 8)}; not escalated)`;
}

function summarizeEvent(event: RunEvent): string {
  const recovery = summarizeRecoveryDashboardEvent(
    event.eventType,
    event.payload
  );
  if (recovery !== undefined) return recovery;

  let payload: unknown;
  try {
    payload = JSON.parse(event.payload);
  } catch {
    payload = undefined;
  }
  const p = asRecord(payload);
  if (p) {
    if (typeof p.message === "string") return `${event.eventType}: ${p.message}`;
    if (typeof p.question === "string") return `asking: ${p.question}`;
    if (typeof p.text === "string") return `${event.eventType}: ${p.text}`;
  }
  return event.eventType;
}

/** Defensive parse of run.metadata payload; both fields must be non-empty strings. */
export function parseRunMetadataPayload(
  payload: string
): { title: string; summary: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as { title?: unknown; summary?: unknown };
  if (typeof obj.title !== "string" || typeof obj.summary !== "string") {
    return null;
  }
  const title = obj.title.trim();
  const summary = obj.summary.trim();
  if (!title || !summary) return null;
  return { title, summary };
}

export function useDashboardData(): DashboardData {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [lastEventByRun, setLastEventByRun] = useState<Record<string, string>>({});
  const [modelByRun, setModelByRun] = useState<Record<string, ModelSelection>>(
    {}
  );
  const [pendingInputByRun, setPendingInputByRun] = useState<
    Record<string, InputRequest>
  >({});
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [a, r, w] = await Promise.all([
        api.listAutomations(),
        api.listRuns(),
        api.listWorkspaces(),
      ]);
      setAutomations(a);
      setRuns(r);
      setWorkspaces(w);
      setError(null);

      // Seed pending input from detail snapshots for needs_input runs so a
      // dashboard refresh restores the gate without relying on a prior WS frame.
      const needing = r.filter((run) => run.status === "needs_input");
      const snapshots = await Promise.all(
        needing.map(async (run) => {
          try {
            return await api.getRun(run.id);
          } catch {
            return null;
          }
        })
      );
      setPendingInputByRun((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const snapshot of snapshots) {
          if (!snapshot) continue;
          const runId = snapshot.run.id;
          const existing = next[runId];
          const pending = snapshot.inputRequests.find(
            (req) => req.status === "pending"
          );
          if (!pending) {
            // Only retire a request this snapshot actually resolved — a WS frame
            // that landed after the fetch is newer than anything we read here.
            const resolved = existing
              ? snapshot.inputRequests.find((req) => req.id === existing.id)
              : undefined;
            if (existing && resolved) {
              delete next[runId];
              changed = true;
            }
            continue;
          }
          if (existing && existing.createdAt > pending.createdAt) continue;
          if (existing?.id === pending.id) continue;
          next[runId] = pending;
          changed = true;
        }
        return changed ? next : prev;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) return;
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      void refresh();
    }, 600);
  }, [refresh]);

  const applyRun = useCallback((run: Run) => {
    setRuns((prev) => {
      const idx = prev.findIndex((r) => r.id === run.id);
      if (idx < 0) return [run, ...prev];
      return prev.map((r) => (r.id === run.id ? run : r));
    });
    setModelByRun((prev) => {
      if (run.modelSelection) {
        return { ...prev, [run.id]: run.modelSelection };
      }
      if (!(run.id in prev)) return prev;
      const next = { ...prev };
      delete next[run.id];
      return next;
    });
  }, []);

  useEffect(() => {
    void refresh();
    // Safety-net poll: reconciles missed events and picks up config-driven
    // automation changes that arrive without a run event.
    const poll = setInterval(() => void refresh(), 8000);
    return () => clearInterval(poll);
  }, [refresh]);

  useEffect(() => {
    return connectLiveSocket({
      onOpen: () => {
        setConnected(true);
        // Catch up board state after reconnect / visibility resume.
        scheduleRefetch();
      },
      onClose: () => setConnected(false),
      onMessage: (msg: WsServerMessage) => {
        if (msg.type === "run_status") {
          setRuns((prev) => {
            const found = prev.some((run) => run.id === msg.runId);
            if (!found) {
              scheduleRefetch();
              return prev;
            }
            return prev.map((run) =>
              run.id === msg.runId ? { ...run, status: msg.status } : run
            );
          });
          if (msg.status !== "needs_input") {
            setPendingInputByRun((prev) => {
              if (!prev[msg.runId]) return prev;
              const next = { ...prev };
              delete next[msg.runId];
              return next;
            });
          }
          // Terminal transitions need endedAt etc. from the server.
          if (["completed", "failed", "cancelled"].includes(msg.status)) {
            scheduleRefetch();
          }
        } else if (msg.type === "run_event") {
          if (msg.event.eventType === "run.metadata") {
            // Generated identity is a run field, not the latest log line.
            const metadata = parseRunMetadataPayload(msg.event.payload);
            if (metadata) {
              setRuns((prev) =>
                prev.map((run) =>
                  run.id === msg.runId
                    ? {
                        ...run,
                        title: metadata.title,
                        summary: metadata.summary,
                      }
                    : run
                )
              );
            }
          } else {
            setLastEventByRun((prev) => ({
              ...prev,
              [msg.runId]: summarizeEvent(msg.event),
            }));
          }
          if (
            msg.event.eventType === "run.started" ||
            msg.event.eventType === "run.resumed"
          ) {
            let payload: unknown;
            try {
              payload = JSON.parse(msg.event.payload);
            } catch {
              payload = undefined;
            }
            const selection = modelSelectionFromLifecyclePayload(payload);
            if (selection) {
              setModelByRun((prev) => ({ ...prev, [msg.runId]: selection }));
            }
          }
          if (msg.event.eventType === "run.model") {
            let payload: unknown;
            try {
              payload = JSON.parse(msg.event.payload);
            } catch {
              payload = undefined;
            }
            const selection =
              modelSelectionFromLifecyclePayload(payload) ?? null;
            setModelByRun((prev) => {
              if (selection) {
                return { ...prev, [msg.runId]: selection };
              }
              if (!(msg.runId in prev)) return prev;
              const next = { ...prev };
              delete next[msg.runId];
              return next;
            });
            setRuns((prev) =>
              prev.map((run) =>
                run.id === msg.runId
                  ? {
                      ...run,
                      modelSelection: selection,
                      model: legacyModelFromSelection(selection),
                    }
                  : run
              )
            );
          }
          setRuns((prev) => {
            if (!prev.some((run) => run.id === msg.runId)) scheduleRefetch();
            return prev;
          });
        } else if (msg.type === "input_request") {
          setPendingInputByRun((prev) => {
            if (msg.request.status === "pending") {
              return { ...prev, [msg.runId]: msg.request };
            }
            const next = { ...prev };
            delete next[msg.runId];
            return next;
          });
        } else if (msg.type === "automation_event") {
          if (msg.action === "deleted") {
            setAutomations((prev) => prev.filter((a) => a.id !== msg.id));
          } else if (msg.automation) {
            setAutomations((prev) => {
              const idx = prev.findIndex((a) => a.id === msg.automation!.id);
              if (idx >= 0) {
                return prev.map((a) =>
                  a.id === msg.automation!.id ? msg.automation! : a
                );
              }
              return [...prev, msg.automation!];
            });
          }
        } else if (msg.type === "runs_deleted") {
          const removed = new Set(msg.runIds);
          setRuns((prev) => prev.filter((run) => !removed.has(run.id)));
          setLastEventByRun((prev) => {
            const next = { ...prev };
            for (const id of msg.runIds) delete next[id];
            return next;
          });
          setModelByRun((prev) => {
            const next = { ...prev };
            for (const id of msg.runIds) delete next[id];
            return next;
          });
          setPendingInputByRun((prev) => {
            const next = { ...prev };
            for (const id of msg.runIds) delete next[id];
            return next;
          });
        }
      },
    });
  }, [scheduleRefetch]);

  return {
    automations,
    runs,
    workspaces,
    lastEventByRun,
    modelByRun,
    pendingInputByRun,
    connected,
    error,
    refresh,
    applyRun,
  };
}
