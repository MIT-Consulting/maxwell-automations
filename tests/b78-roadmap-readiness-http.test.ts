import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IMPLEMENT_FULLY_PIPELINE_ID,
  PER_PERSON_IDEA_REFUSAL,
  roadmapReadinessHasBlockers,
} from "@lca/shared";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { freeListenPort } from "./helpers/free-port.ts";

function writeIndex(workspace: string, body: string): void {
  mkdirSync(join(workspace, "docs", "roadmap"), { recursive: true });
  writeFileSync(join(workspace, "docs", "roadmap", "00-index.md"), body);
}

function minimalIndex(next = "b99"): string {
  return `# Roadmap

<!-- next: ${next} -->

## Backlog

## Completed

| ID | Feature | Description | Docs |
|----|---------|-------------|------|
`;
}

function noopExecutor(): Executor {
  return {
    kind: "sdk-local",
    spawn: async () => {
      throw new Error("spawn not expected");
    },
    resume: async () => {
      throw new Error("resume not expected");
    },
  };
}

async function withServer(
  opts: {
    workspaceFiles?: (workspace: string) => void;
    withGit?: boolean;
    workspaceId?: string;
    extraWorkspaces?: Array<{ id: string; path: string }>;
  },
  run: (ctx: {
    base: string;
    workspace: string;
    workspaceId: string;
  }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "lca-b78-http-"));
  const db = openDatabase(join(root, "state.sqlite"));
  const workspace = join(root, "workspace");
  const workspaceId = opts.workspaceId ?? "ws";
  mkdirSync(workspace, { recursive: true });
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
  ).run(workspaceId, workspace, "Primary");
  if (opts.withGit !== false) {
    mkdirSync(join(workspace, ".git"), { recursive: true });
  }
  opts.workspaceFiles?.(workspace);
  for (const extra of opts.extraWorkspaces ?? []) {
    mkdirSync(extra.path, { recursive: true });
    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
    ).run(extra.id, extra.path, extra.id);
  }
  const port = await freeListenPort();
  const chatEngine = new ChatEngine(db, {
    apiKey: "test",
    executor: noopExecutor(),
  });
  const http = await startHttpServer({
    engine: {} as never,
    chatEngine,
    store: new DashboardStore(db),
    db,
    events: new DaemonEventBus(),
    apiKey: "test",
    settings: DEFAULT_SETTINGS,
    port,
  });
  try {
    await run({ base: `http://127.0.0.1:${port}`, workspace, workspaceId });
  } finally {
    await http.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("b78 roadmap readiness HTTP", () => {
  it("returns full report and summary boundaries", async () => {
    await withServer(
      {
        workspaceFiles: (ws) => {
          writeIndex(ws, minimalIndex("b90"));
          writeFileSync(join(ws, "ROADMAP.md"), "# Old backlog\n");
        },
      },
      async ({ base, workspaceId }) => {
        const full = await fetch(
          `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/roadmap-readiness`
        );
        expect(full.status).toBe(200);
        const report = (await full.json()) as {
          state: string;
          findings: unknown[];
          features: unknown[];
          candidates: Array<{ path: string }>;
        };
        expect(report.state).toBe("ready");
        expect(report.candidates.some((c) => c.path === "ROADMAP.md")).toBe(
          true
        );
        expect(report.features).toEqual([]);

        const summaries = await fetch(`${base}/api/roadmap-readiness`);
        expect(summaries.status).toBe(200);
        const body = (await summaries.json()) as {
          workspaces: Array<{
            workspaceId: string;
            state: string;
            counts: Record<string, number>;
          }>;
        };
        expect(body.workspaces).toHaveLength(1);
        expect(body.workspaces[0]!.workspaceId).toBe(workspaceId);
        expect(body.workspaces[0]!.state).toBe("ready");
        expect(body.workspaces[0]!.counts.info).toBeGreaterThan(0);
        expect(
          (body.workspaces[0] as { features?: unknown }).features
        ).toBeUndefined();
      }
    );
  });

  it("reports empty and adoptable workspaces", async () => {
    const emptyPath = join(tmpdir(), "lca-b78-empty-" + Date.now());
    await withServer(
      {
        extraWorkspaces: [{ id: "empty-ws", path: emptyPath }],
        workspaceFiles: (ws) => {
          writeIndex(ws, minimalIndex());
        },
      },
      async ({ base, workspaceId }) => {
        mkdirSync(join(emptyPath, ".git"), { recursive: true });
        const emptyRes = await fetch(`${base}/api/roadmap-readiness`);
        const emptyBody = (await emptyRes.json()) as {
          workspaces: Array<{ workspaceId: string; state: string }>;
        };
        const empty = emptyBody.workspaces.find((w) => w.workspaceId === "empty-ws");
        expect(empty?.state).toBe("empty");

        writeFileSync(join(emptyPath, "ROADMAP.md"), "## Backlog\n- item\n");
        const adoptRes = await fetch(
          `${base}/api/workspaces/empty-ws/roadmap-readiness`
        );
        const adopt = (await adoptRes.json()) as { state: string };
        expect(adopt.state).toBe("adoptable");

        const readyRes = await fetch(
          `${base}/api/workspaces/${workspaceId}/roadmap-readiness`
        );
        const ready = (await readyRes.json()) as { state: string };
        expect(ready.state).toBe("ready");
      }
    );
    rmSync(emptyPath, { recursive: true, force: true });
  });

  it("returns 404 for unknown workspace and rejects traversal paths", async () => {
    await withServer(
      { workspaceFiles: (ws) => writeIndex(ws, minimalIndex()) },
      async ({ base, workspaceId }) => {
        const missing = await fetch(
          `${base}/api/workspaces/missing-ws/roadmap-readiness`
        );
        expect(missing.status).toBe(404);

        const traversal = await fetch(
          `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/roadmap-readiness?path=../etc/passwd`
        );
        expect(traversal.status).toBe(200);

        const badFile = await fetch(
          `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/files/content?path=../etc/passwd`
        );
        expect(badFile.status).toBe(400);
      }
    );
  });

  it("adds readiness to pipeline introspection while keeping booleans", async () => {
    await withServer(
      { workspaceFiles: (ws) => writeIndex(ws, minimalIndex()) },
      async ({ base, workspaceId }) => {
        const res = await fetch(
          `${base}/api/pipelines/${IMPLEMENT_FULLY_PIPELINE_ID}?workspaceId=${encodeURIComponent(workspaceId)}`
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          preconditions?: {
            gitRepo: boolean;
            roadmapIndex: boolean;
            roadmapReadiness?: { state: string };
          };
        };
        expect(body.preconditions?.gitRepo).toBe(true);
        expect(body.preconditions?.roadmapIndex).toBe(true);
        expect(body.preconditions?.roadmapReadiness?.state).toBe("ready");
      }
    );
  });

  it("uses readiness blockers at kickoff resolve", async () => {
    await withServer(
      {
        withGit: false,
        workspaceFiles: (ws) => writeIndex(ws, minimalIndex("b90")),
      },
      async ({ base, workspaceId }) => {
        const res = await fetch(
          `${base}/api/pipelines/${IMPLEMENT_FULLY_PIPELINE_ID}/resolve`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceId,
              input: { kind: "idea", idea: "needs git" },
            }),
          }
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toMatch(/git/i);
        expect(body.error).toMatch(/git init/i);
      }
    );

    await withServer(
      {
        workspaceFiles: (ws) => {
          writeIndex(
            ws,
            `# Roadmap
<!-- next: b-xy64 -->
<!-- next: b-qr57 -->
## Backlog
## Completed
| ID | Feature | Description | Docs |
|----|---------|-------------|------|
`
          );
        },
      },
      async ({ base, workspaceId }) => {
        const res = await fetch(
          `${base}/api/pipelines/${IMPLEMENT_FULLY_PIPELINE_ID}/resolve`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceId,
              input: { kind: "idea", idea: "blocked" },
            }),
          }
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe(PER_PERSON_IDEA_REFUSAL);
      }
    );

    await withServer(
      {
        workspaceFiles: (ws) => {
          mkdirSync(join(ws, "docs"), { recursive: true });
        },
      },
      async ({ base, workspaceId }) => {
        const res = await fetch(
          `${base}/api/pipelines/${IMPLEMENT_FULLY_PIPELINE_ID}/resolve`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceId,
              input: { kind: "idea", idea: "needs index" },
            }),
          }
        );
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: string };
        expect(body.error).toMatch(/roadmap index/i);
      }
    );
  });

  it("flags truncated index as blocks-all", async () => {
    await withServer(
      {
        workspaceFiles: (ws) => {
          writeIndex(ws, "x".repeat(DEFAULT_SETTINGS.maxFileViewerBytes + 1));
        },
      },
      async ({ base, workspaceId }) => {
        const res = await fetch(
          `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/roadmap-readiness`
        );
        const report = (await res.json()) as {
          findings: Array<{ code: string; impact: string }>;
        };
        expect(
          report.findings.some((f) => f.code === "index-truncated")
        ).toBe(true);
        expect(roadmapReadinessHasBlockers(report as never)).toBe(true);

        const resolve = await fetch(
          `${base}/api/pipelines/${IMPLEMENT_FULLY_PIPELINE_ID}/resolve`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceId,
              input: { kind: "idea", idea: "x" },
            }),
          }
        );
        expect(resolve.status).toBe(400);
      }
    );
  });

  it("reports malformed indexes and omits readiness from workspace list", async () => {
    await withServer(
      {
        workspaceFiles: (ws) => {
          writeIndex(
            ws,
            `# Roadmap
<!-- id-format: b<n> -->
<!-- id-format: b-<owner><n> -->
<!-- next: b90 -->
## Backlog
## Completed
| ID | Feature | Description | Docs |
|----|---------|-------------|------|
`
          );
        },
      },
      async ({ base, workspaceId, workspace }) => {
        const res = await fetch(
          `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/roadmap-readiness`
        );
        expect(res.status).toBe(200);
        const report = (await res.json()) as {
          findings: Array<{ code: string; impact: string }>;
        };
        expect(report.findings.some((f) => f.code === "malformed-index")).toBe(
          true
        );
        const serialized = JSON.stringify(report);
        expect(serialized).not.toContain(workspace.replace(/\\/g, "/"));
        expect(serialized).not.toMatch(/[A-Za-z]:\\/);

        const listed = await fetch(`${base}/api/workspaces`);
        expect(listed.status).toBe(200);
        const body = (await listed.json()) as {
          workspaces: Array<{ roadmapReadiness?: unknown }>;
        };
        expect(body.workspaces[0]?.roadmapReadiness).toBeUndefined();
      }
    );
  });

  it("does not follow symlink candidates or leak outside content", async () => {
    await withServer(
      {
        workspaceFiles: (ws) => {
          writeIndex(ws, minimalIndex());
          const outside = join(ws, "..", "secret-outside.txt");
          writeFileSync(outside, "secret-outside");
          try {
            symlinkSync(outside, join(ws, "ROADMAP.md"));
          } catch (err) {
            console.warn(
              "skipping symlink candidate case — platform refused symlink:",
              err
            );
          }
        },
      },
      async ({ base, workspaceId, workspace }) => {
        const { existsSync } = await import("node:fs");
        if (!existsSync(join(workspace, "ROADMAP.md"))) return;
        const res = await fetch(
          `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/roadmap-readiness`
        );
        expect(res.status).toBe(200);
        const report = (await res.json()) as {
          candidates: Array<{ path: string }>;
        };
        expect(JSON.stringify(report)).not.toContain("secret-outside");
        expect(report.candidates.some((c) => c.path === "ROADMAP.md")).toBe(
          false
        );
      }
    );
  });

  it("allows --feature kickoff when only idea-only findings exist", async () => {
    await withServer(
      {
        workspaceFiles: (ws) => {
          writeIndex(
            ws,
            `# Roadmap
<!-- next: b-xy64 -->
<!-- next: b-qr57 -->
## Documented Ideas
| ID | Idea | Status | File |
| ---- | ---- | ------ | ---- |
| b-xy58 | Thin per-person feature | Planned | [child](./b-xy58-thin-feature.md) |
## Completed
| ID | Feature | Description | Docs |
|----|---------|-------------|------|
`
          );
          writeFileSync(
            join(ws, "docs", "roadmap", "b-xy58-thin-feature.md"),
            "# b-xy58\n"
          );
        },
      },
      async ({ base, workspaceId }) => {
        const idea = await fetch(
          `${base}/api/pipelines/${IMPLEMENT_FULLY_PIPELINE_ID}/resolve`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceId,
              input: { kind: "idea", idea: "blocked" },
            }),
          }
        );
        expect(idea.status).toBe(400);
        const ideaBody = (await idea.json()) as { error: string };
        expect(ideaBody.error).toBe(PER_PERSON_IDEA_REFUSAL);

        const feature = await fetch(
          `${base}/api/pipelines/${IMPLEMENT_FULLY_PIPELINE_ID}/resolve`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceId,
              input: { kind: "feature-id", featureId: "b-xy58" },
            }),
          }
        );
        expect(feature.status).toBe(200);
        const resolved = (await feature.json()) as { featureId: string };
        expect(resolved.featureId).toBe("b-xy58");
      }
    );
  });
});
