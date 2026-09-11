import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActiveRun, Executor, SpawnParams } from "../packages/daemon/src/executor/types.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";

function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("until() timed out"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function seedArtifactWorkspace(workspace: string): void {
  mkdirSync(join(workspace, ".cursor", "rules"), { recursive: true });
  mkdirSync(join(workspace, ".cursor", "skills", "lca-dev"), { recursive: true });
  writeFileSync(
    join(workspace, ".cursor", "rules", "tech-stack.mdc"),
    ["---", "description: Project stack", "---", "# Tech Stack"].join("\n")
  );
  writeFileSync(
    join(workspace, ".cursor", "skills", "lca-dev", "SKILL.md"),
    ["---", "name: lca-dev", "description: Start dev", "---", "# LCA Dev"].join(
      "\n"
    )
  );
}

describe("RunEngine prompt reference resolution", () => {
  it("passes resolved references to executor spawn and logs the reference summary", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b5-engine-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    seedArtifactWorkspace(workspace);

    const db = openDatabase(join(root, "state.sqlite"));
    let spawned: SpawnParams | null = null;
    const activeRun: ActiveRun = {
      kind: "sdk-local",
      agentId: "agent-b5",
      sdkRunId: "sdk-b5",
      async *stream() {},
      wait: async () => ({ status: "finished" }) as never,
      cancel: async () => {},
      dispose: async () => {},
    };
    const executor: Executor = {
      kind: "sdk-local",
      spawn: async (params) => {
        spawned = params;
        return activeRun;
      },
      resume: async () => {
        throw new Error("resume should not be called");
      },
    };

    const inputHub = new InputHub(new InputStore(db), {
      onNeedsInput: () => {},
      onAnswered: () => {},
    });
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor,
      inputHub,
      maxConcurrentRuns: 1,
    });

    try {
      db.prepare("INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)").run(
        "ws",
        workspace,
        "Workspace"
      );
      db.prepare(
        `INSERT INTO automations (
          id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
        ) VALUES (?, ?, ?, 1, 'enabled', ?, ?, ?, ?)`
      ).run(
        "auto",
        "ws",
        "B5",
        JSON.stringify({ type: "manual" }),
        "Use @tech-stack and /lca-dev, but keep @missing visible.",
        "test.yaml",
        "auto"
      );

      const runId = await engine.triggerRun("auto");
      await until(() => {
        const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
          | { status: string }
          | undefined;
        return row?.status === "completed";
      });

      expect(spawned?.prompt).toContain(
        "Apply the `tech-stack` rule (.cursor/rules/tech-stack.mdc)"
      );
      expect(spawned?.prompt).toContain(
        "Use the `lca-dev` skill (.cursor/skills/lca-dev/SKILL.md)"
      );
      expect(spawned?.prompt).toContain("@missing");
      expect(spawned?.prompt).not.toContain("@tech-stack");
      expect(spawned?.prompt).not.toMatch(/(^|\s)\/lca-dev([\s,.]|$)/);

      const events = db
        .prepare(
          "SELECT seq, event_type, payload FROM run_events WHERE run_id = ? ORDER BY seq ASC"
        )
        .all(runId) as Array<{ seq: number; event_type: string; payload: string }>;
      const startedIndex = events.findIndex((event) => event.event_type === "run.started");
      const referencesIndex = events.findIndex(
        (event) => event.event_type === "run.references"
      );
      expect(startedIndex).toBeGreaterThanOrEqual(0);
      expect(referencesIndex).toBeGreaterThan(startedIndex);

      const referencePayload = JSON.parse(events[referencesIndex].payload) as {
        resolved: number;
        unknown: number;
        unknownReferences: Array<{ raw: string }>;
      };
      expect(referencePayload).toMatchObject({
        resolved: 2,
        unknown: 1,
        unknownReferences: [{ raw: "@missing" }],
      });
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
