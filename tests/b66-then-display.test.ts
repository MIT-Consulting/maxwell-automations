import { describe, expect, it } from "vitest";
import type { RunSnapshot } from "../packages/cli/src/client.ts";
import {
  collectPipelineDoctorFacts,
  formatPipelineBlockLines,
} from "../packages/cli/src/doctor.ts";
import {
  emptyQueueEntryDetail,
  type Automation,
} from "@lca/shared";
import { readQueueEntryDetail } from "../packages/shared/src/feature-queue-preview.ts";

function kickoffJson(then: unknown): string {
  return JSON.stringify({
    automationId: "auto-1",
    variables: {
      featureId: "b66",
      featureSlug: "b66-pipeline-then-chaining",
      then,
    },
  });
}

function pipelineRun(
  overrides: Partial<RunSnapshot["run"]> = {}
): RunSnapshot["run"] {
  return {
    id: "run-aaaaaaaa",
    status: "running",
    automation_id: "ws::generated:implement",
    workspace_id: "ws-1",
    trigger_kind: "chain",
    agent_id: null,
    sdk_run_id: null,
    prompt: null,
    title: null,
    summary: null,
    started_at: "2026-07-10 12:00:00",
    ended_at: null,
    created_at: "2026-07-10 12:00:00",
    chain_root_run_id: "root-bbbbbbbb",
    chain_depth: 2,
    chain_max_depth: 9,
    chain_context_json: JSON.stringify({
      variables: {
        pipelineId: "implement-fully",
        featureId: "b66",
        featureSlug: "b66-pipeline-then-chaining",
        then: "ship",
      },
    }),
    ...overrides,
  };
}

function automation(configKey: string): Automation {
  return {
    id: `ws::${configKey}`,
    workspaceId: "ws-1",
    name: configKey,
    enabled: true,
    status: "enabled",
    origin: "config",
    trigger: { type: "manual" },
    prompt: "x",
    model: null,
    modelSelection: null,
    chain: null,
    configPath: "automations.yaml",
    configKey,
    archivedAt: null,
    createdAt: "2026-07-10 12:00:00",
    updatedAt: "2026-07-10 12:00:00",
  };
}

describe("b66 then display", () => {
  describe("readQueueEntryDetail", () => {
    it("returns then: ship when set", () => {
      expect(readQueueEntryDetail(kickoffJson("ship")).then).toBe("ship");
    });

    it("returns then: null for none, empty, and missing", () => {
      expect(readQueueEntryDetail(kickoffJson("none")).then).toBeNull();
      expect(readQueueEntryDetail(kickoffJson("")).then).toBeNull();
      expect(readQueueEntryDetail(kickoffJson(undefined)).then).toBeNull();
      expect(readQueueEntryDetail("{")).toEqual(emptyQueueEntryDetail());
    });
  });

  describe("formatPipelineBlockLines", () => {
    it("prints then: ship when set and omits for none", () => {
      const withThen: RunSnapshot = {
        run: pipelineRun(),
        events: [],
        inputRequests: [],
      };
      const facts = collectPipelineDoctorFacts(
        withThen,
        automation("generated:implement")
      );
      expect(facts!.then).toBe("ship");
      const block = formatPipelineBlockLines(facts!).join("\n");
      expect(block).toMatch(/then:\s+ship/);

      const withoutThen: RunSnapshot = {
        run: pipelineRun({
          chain_context_json: JSON.stringify({
            variables: {
              pipelineId: "implement-fully",
              featureId: "b66",
              then: "none",
            },
          }),
        }),
        events: [],
        inputRequests: [],
      };
      const noneFacts = collectPipelineDoctorFacts(
        withoutThen,
        automation("generated:implement")
      );
      expect(noneFacts!.then).toBeNull();
      expect(formatPipelineBlockLines(noneFacts!).join("\n")).not.toMatch(
        /then:/
      );
    });
  });
});
