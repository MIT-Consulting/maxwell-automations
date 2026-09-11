import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHAIN_VALUE_MAX_LENGTH,
  IMPLEMENT_FULLY_PIPELINE_ID,
  IMPLEMENT_FULLY_VARIABLES,
  buildKickoffVariables,
  resolveImplementFullyKickoffSchema,
  validateFeatureSlugIdea,
} from "@lca/shared";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import {
  RoadmapResolveError,
  resolveImplementFullyKickoff,
} from "../packages/daemon/src/roadmap/resolve.ts";
import type { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { freeListenPort } from "./helpers/free-port.ts";

const BOUNDS = { maxBytes: 256 * 1024, maxEntries: 1000 };

function assertKickoffCompatible(
  featureId: string,
  featureSlug: string,
  idea: string
): void {
  expect(() =>
    validateFeatureSlugIdea(featureId, featureSlug, idea)
  ).not.toThrow();
  const vars = buildKickoffVariables(featureId, featureSlug, idea);
  expect(Object.keys(vars).sort()).toEqual(
    [...IMPLEMENT_FULLY_VARIABLES].sort()
  );
  expect(vars.featureDir).toBe(`docs/roadmap/${featureSlug}`);
  expect(vars.featureIndex).toBe(
    `docs/roadmap/${featureSlug}/00-index.md`
  );
  expect(vars.featureDir.includes("\\")).toBe(false);
  expect(vars.featureIndex.includes("\\")).toBe(false);
}

function writeIndex(workspace: string, body: string): void {
  mkdirSync(join(workspace, "docs", "roadmap"), { recursive: true });
  writeFileSync(join(workspace, "docs", "roadmap", "00-index.md"), body);
}

function minimalIndex(opts: {
  next?: string;
  backlog?: string[];
  documented?: string[];
  completed?: string[];
}): string {
  const next = opts.next ?? "b99";
  const backlog = (opts.backlog ?? []).join("\n");
  const documentedRows = (opts.documented ?? []).join("\n");
  const completedRows = (opts.completed ?? []).join("\n");
  return `# Roadmap

<!-- next: ${next} -->

## Backlog

${backlog}

## Completed

| ID | Feature | Description | Docs |
|----|---------|-------------|------|
${completedRows}

## Documented Ideas

| ID | Idea | Status | File |
|----|------|--------|------|
${documentedRows}
`;
}

function withTempWorkspace(
  setup: (workspace: string) => void,
  run: (workspace: string) => void
): void {
  const root = mkdtempSync(join(tmpdir(), "lca-b42-resolve-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(workspace, ".git"), { recursive: true });
  try {
    setup(workspace);
    run(workspace);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function seedWorkspace(
  db: ReturnType<typeof openDatabase>,
  workspace: string,
  workspaceId = "ws"
): void {
  mkdirSync(workspace, { recursive: true });
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, 'Workspace')"
  ).run(workspaceId, workspace);
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
  },
  run: (ctx: {
    base: string;
    workspace: string;
    workspaceId: string;
    db: ReturnType<typeof openDatabase>;
  }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "lca-b42-http-"));
  const db = openDatabase(join(root, "state.sqlite"));
  const workspace = join(root, "workspace");
  const workspaceId = opts.workspaceId ?? "ws";
  seedWorkspace(db, workspace, workspaceId);
  if (opts.withGit !== false) {
    mkdirSync(join(workspace, ".git"), { recursive: true });
  }
  opts.workspaceFiles?.(workspace);
  const port = await freeListenPort();
  const chatEngine = new ChatEngine(db, {
    apiKey: "test",
    executor: noopExecutor(),
  });
  const http = await startHttpServer({
    engine: {} as unknown as RunEngine,
    chatEngine,
    store: new DashboardStore(db),
    db,
    events: new DaemonEventBus(),
    apiKey: "test",
    settings: DEFAULT_SETTINGS,
    port,
  });
  try {
    await run({
      base: `http://127.0.0.1:${port}`,
      workspace,
      workspaceId,
      db,
    });
  } finally {
    await http.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("b42.1 resolveImplementFullyKickoffSchema", () => {
  it("accepts feature-id and idea variants", () => {
    expect(
      resolveImplementFullyKickoffSchema.safeParse({
        workspaceId: "ws",
        input: { kind: "feature-id", featureId: "b42" },
      }).success
    ).toBe(true);
    expect(
      resolveImplementFullyKickoffSchema.safeParse({
        workspaceId: "ws",
        input: { kind: "idea", idea: "  Ship thinner kickoff  " },
      }).data?.input
    ).toEqual({ kind: "idea", idea: "Ship thinner kickoff" });
  });

  it("rejects invalid id, blank idea, over-limit idea, extra keys, both/neither", () => {
    expect(
      resolveImplementFullyKickoffSchema.safeParse({
        workspaceId: "ws",
        input: { kind: "feature-id", featureId: "feature-42" },
      }).success
    ).toBe(false);
    expect(
      resolveImplementFullyKickoffSchema.safeParse({
        workspaceId: "ws",
        input: { kind: "idea", idea: "   " },
      }).success
    ).toBe(false);
    const over = "é".repeat(CHAIN_VALUE_MAX_LENGTH); // 2 bytes each when over limit
    expect(new TextEncoder().encode(over).length).toBeGreaterThan(
      CHAIN_VALUE_MAX_LENGTH
    );
    expect(
      resolveImplementFullyKickoffSchema.safeParse({
        workspaceId: "ws",
        input: { kind: "idea", idea: over },
      }).success
    ).toBe(false);
    expect(
      resolveImplementFullyKickoffSchema.safeParse({
        workspaceId: "ws",
        input: { kind: "feature-id", featureId: "b42" },
        extra: true,
      }).success
    ).toBe(false);
    expect(
      resolveImplementFullyKickoffSchema.safeParse({
        workspaceId: "ws",
        input: {
          kind: "feature-id",
          featureId: "b42",
          idea: "nope",
        },
      }).success
    ).toBe(false);
    expect(
      resolveImplementFullyKickoffSchema.safeParse({
        workspaceId: "ws",
        input: { kind: "idea" },
      }).success
    ).toBe(false);
    expect(
      resolveImplementFullyKickoffSchema.safeParse({
        workspaceId: "ws",
      }).success
    ).toBe(false);
  });
});

describe("b42.1 resolveImplementFullyKickoff (existing feature)", () => {
  it("uses exact existing folder slug and prefers Backlog over Documented Ideas", () => {
    withTempWorkspace(
      (workspace) => {
        writeIndex(
          workspace,
          minimalIndex({
            backlog: [
              `- **b42** Thinner kickoff — from backlog. — [feature docs](./b42-thinner-impl-fully/00-index.md)`,
            ],
            documented: [
              `| b42 | Documented title | Planned | [b42-thinner-impl-fully/00-index.md](./b42-thinner-impl-fully/00-index.md) |`,
            ],
          })
        );
        mkdirSync(
          join(workspace, "docs", "roadmap", "b42-thinner-impl-fully"),
          { recursive: true }
        );
        writeFileSync(
          join(
            workspace,
            "docs",
            "roadmap",
            "b42-thinner-impl-fully",
            "00-index.md"
          ),
          "# b42\n"
        );
        writeFileSync(
          join(
            workspace,
            "docs",
            "roadmap",
            "b42-thinner-impl-fully",
            "prd.md"
          ),
          "# prd\n"
        );
      },
      (workspace) => {
        const resolved = resolveImplementFullyKickoff(
          workspace,
          { kind: "feature-id", featureId: "b42" },
          BOUNDS
        );
        expect(resolved.featureId).toBe("b42");
        expect(resolved.featureSlug).toBe("b42-thinner-impl-fully");
        expect(resolved.idea).not.toContain("Documented title");
        // The trailing link is metadata: its path becomes prior art, its
        // label never becomes prose.
        expect(resolved.idea).not.toContain("feature docs");
        expect(resolved.idea).toBe(
          "Thinner kickoff — from backlog. Prior art: docs/roadmap/b42-thinner-impl-fully/prd.md."
        );
        assertKickoffCompatible(
          resolved.featureId,
          resolved.featureSlug,
          resolved.idea
        );
      }
    );
  });

  it("uses a single document stem and row-derived slug when needed", () => {
    withTempWorkspace(
      (workspace) => {
        writeIndex(
          workspace,
          minimalIndex({
            backlog: [
              `- **b23** Remote daemon — stand up lab-host. — [plan](./b23-remote-daemon-on-lab-host.md)`,
              `- **b37** Cleaner board columns — resize and persist widths.`,
            ],
          })
        );
        writeFileSync(
          join(
            workspace,
            "docs",
            "roadmap",
            "b23-remote-daemon-on-lab-host.md"
          ),
          "# b23\n"
        );
      },
      (workspace) => {
        const doc = resolveImplementFullyKickoff(
          workspace,
          { kind: "feature-id", featureId: "b23" },
          BOUNDS
        );
        expect(doc.featureSlug).toBe("b23-remote-daemon-on-lab-host");
        expect(doc.idea).toContain(
          "Prior art: docs/roadmap/b23-remote-daemon-on-lab-host.md."
        );
        assertKickoffCompatible(doc.featureId, doc.featureSlug, doc.idea);

        const derived = resolveImplementFullyKickoff(
          workspace,
          { kind: "feature-id", featureId: "b37" },
          BOUNDS
        );
        expect(derived.featureSlug).toBe(
          "b37-cleaner-board-columns-resize-and-persist"
        );
        expect(derived.idea).toContain("Cleaner board columns");
        expect(derived.idea).not.toMatch(/Prior art:/);
        assertKickoffCompatible(
          derived.featureId,
          derived.featureSlug,
          derived.idea
        );
      }
    );
  });

  it("keeps Documented Ideas status text out of the composed idea", () => {
    withTempWorkspace(
      (workspace) => {
        writeIndex(
          workspace,
          minimalIndex({
            documented: [
              `| b15 | Adaptive chain generation (planner skill) | Superseded by b36 | [b15-adaptive-chain-generation.md](./b15-adaptive-chain-generation.md) |`,
            ],
          })
        );
        writeFileSync(
          join(
            workspace,
            "docs",
            "roadmap",
            "b15-adaptive-chain-generation.md"
          ),
          "# b15\n"
        );
      },
      (workspace) => {
        const resolved = resolveImplementFullyKickoff(
          workspace,
          { kind: "feature-id", featureId: "b15" },
          BOUNDS
        );
        expect(resolved.featureSlug).toBe("b15-adaptive-chain-generation");
        expect(resolved.idea).not.toContain("Superseded by b36");
        expect(resolved.idea).toBe(
          "Adaptive chain generation (planner skill) Prior art: docs/roadmap/b15-adaptive-chain-generation.md."
        );
        assertKickoffCompatible(
          resolved.featureId,
          resolved.featureSlug,
          resolved.idea
        );
      }
    );
  });

  it("disambiguates folders via safe index link and rejects unresolved ambiguity", () => {
    withTempWorkspace(
      (workspace) => {
        writeIndex(
          workspace,
          minimalIndex({
            backlog: [
              `- **b10** Linked pick — choose one. — [docs](./b10-chosen-slug/00-index.md)`,
              `- **b11** Ambiguous twin — no selector.`,
            ],
          })
        );
        for (const name of [
          "b10-chosen-slug",
          "b10-other-slug",
          "b11-alpha-slug",
          "b11-beta-slug",
        ]) {
          mkdirSync(join(workspace, "docs", "roadmap", name), {
            recursive: true,
          });
          writeFileSync(
            join(workspace, "docs", "roadmap", name, "00-index.md"),
            `# ${name}\n`
          );
        }
      },
      (workspace) => {
        const linked = resolveImplementFullyKickoff(
          workspace,
          { kind: "feature-id", featureId: "b10" },
          BOUNDS
        );
        expect(linked.featureSlug).toBe("b10-chosen-slug");
        assertKickoffCompatible(
          linked.featureId,
          linked.featureSlug,
          linked.idea
        );

        expect(() =>
          resolveImplementFullyKickoff(
            workspace,
            { kind: "feature-id", featureId: "b11" },
            BOUNDS
          )
        ).toThrow(RoadmapResolveError);
        try {
          resolveImplementFullyKickoff(
            workspace,
            { kind: "feature-id", featureId: "b11" },
            BOUNDS
          );
        } catch (err) {
          expect(err).toBeInstanceOf(RoadmapResolveError);
          expect((err as RoadmapResolveError).category).toBe("bad_request");
          expect((err as RoadmapResolveError).message).toMatch(/Ambiguous/);
          expect((err as RoadmapResolveError).message).not.toMatch(/[A-Z]:\\/);
        }
      }
    );
  });

  it("rejects unknown id, same-section duplicates, and unsafe links", () => {
    withTempWorkspace(
      (workspace) => {
        writeIndex(
          workspace,
          minimalIndex({
            backlog: [
              `- **b42** One — first.`,
              `- **b42** Two — duplicate same section.`,
              `- **b43** Escape — [bad](./../../secret.txt)`,
              `- **b44** Abs — [bad](/etc/passwd)`,
              `- **b45** Slash — [bad](.\\evil.md)`,
            ],
          })
        );
        writeFileSync(join(workspace, "secret.txt"), "secret-value");
      },
      (workspace) => {
        try {
          resolveImplementFullyKickoff(
            workspace,
            { kind: "feature-id", featureId: "b99" },
            BOUNDS
          );
          expect.fail("expected not_found");
        } catch (err) {
          expect(err).toBeInstanceOf(RoadmapResolveError);
          expect((err as RoadmapResolveError).category).toBe("not_found");
        }

        try {
          resolveImplementFullyKickoff(
            workspace,
            { kind: "feature-id", featureId: "b42" },
            BOUNDS
          );
          expect.fail("expected duplicate failure");
        } catch (err) {
          expect(err).toBeInstanceOf(RoadmapResolveError);
          expect((err as RoadmapResolveError).category).toBe("bad_request");
          expect((err as RoadmapResolveError).message).toMatch(/duplicate/i);
        }

        for (const id of ["b43", "b44", "b45"] as const) {
          try {
            resolveImplementFullyKickoff(
              workspace,
              { kind: "feature-id", featureId: id },
              BOUNDS
            );
            expect.fail(`expected unsafe failure for ${id}`);
          } catch (err) {
            expect(err).toBeInstanceOf(RoadmapResolveError);
            expect((err as RoadmapResolveError).category).toBe("bad_request");
            expect((err as RoadmapResolveError).message).not.toContain(
              "secret-value"
            );
            expect((err as RoadmapResolveError).message).not.toMatch(
              /[A-Z]:\\/
            );
          }
        }
      }
    );
  });

  it("rejects symlink candidates when the platform allows creating them", () => {
    withTempWorkspace(
      (workspace) => {
        writeIndex(
          workspace,
          minimalIndex({
            backlog: [`- **b50** Symlink feature — should fail.`],
          })
        );
        const target = join(workspace, "docs", "roadmap", "b50-real-dir");
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, "00-index.md"), "# real\n");
        try {
          symlinkSync(
            target,
            join(workspace, "docs", "roadmap", "b50-link-slug")
          );
        } catch {
          // Platform denied symlink creation — skip assertion below.
          writeFileSync(join(workspace, ".skip-symlink"), "1");
        }
      },
      (workspace) => {
        if (existsSync(join(workspace, ".skip-symlink"))) return;
        expect(() =>
          resolveImplementFullyKickoff(
            workspace,
            { kind: "feature-id", featureId: "b50" },
            BOUNDS
          )
        ).toThrow(/symlink/i);
      }
    );
  });
});

describe("b42.1 resolveImplementFullyKickoff (idea-only)", () => {
  it("allocates the next marker id, derives slug, and never mutates files", () => {
    withTempWorkspace(
      (workspace) => {
        writeIndex(
          workspace,
          minimalIndex({
            next: "b44",
            backlog: [
              `- **b42** Existing — stay put. — [docs](./b42-existing/00-index.md)`,
            ],
          })
        );
        mkdirSync(join(workspace, "docs", "roadmap", "b42-existing"), {
          recursive: true,
        });
        writeFileSync(
          join(
            workspace,
            "docs",
            "roadmap",
            "b42-existing",
            "00-index.md"
          ),
          "# b42\n"
        );
      },
      (workspace) => {
        const before = readdirSync(join(workspace, "docs", "roadmap")).sort();
        const indexBefore = readFileSync(
          join(workspace, "docs", "roadmap", "00-index.md"),
          "utf8"
        );
        const resolved = resolveImplementFullyKickoff(
          workspace,
          {
            kind: "idea",
            idea: "  Brand new thinner kickoff experience  ",
          },
          BOUNDS
        );
        expect(resolved).toEqual({
          featureId: "b44",
          featureSlug: "b44-brand-new-thinner-kickoff-experience",
          idea: "Brand new thinner kickoff experience",
        });
        assertKickoffCompatible(
          resolved.featureId,
          resolved.featureSlug,
          resolved.idea
        );
        expect(readdirSync(join(workspace, "docs", "roadmap")).sort()).toEqual(
          before
        );
        expect(
          readFileSync(
            join(workspace, "docs", "roadmap", "00-index.md"),
            "utf8"
          )
        ).toBe(indexBefore);
      }
    );
  });

  it("rejects missing/duplicate/stale markers and unusable slug sources", () => {
    withTempWorkspace(
      (workspace) => {
        mkdirSync(join(workspace, "docs", "roadmap"), { recursive: true });
        writeFileSync(
          join(workspace, "docs", "roadmap", "00-index.md"),
          `# Roadmap\n\n## Backlog\n\n- **b1** X — y.\n`
        );
      },
      (workspace) => {
        expect(() =>
          resolveImplementFullyKickoff(
            workspace,
            { kind: "idea", idea: "no marker" },
            BOUNDS
          )
        ).toThrow(/missing the next-id marker/i);
      }
    );

    withTempWorkspace(
      (workspace) => {
        writeIndex(
          workspace,
          `# Roadmap\n\n<!-- next: b44 -->\n<!-- next: b45 -->\n\n## Backlog\n`
        );
      },
      (workspace) => {
        expect(() =>
          resolveImplementFullyKickoff(
            workspace,
            { kind: "idea", idea: "dup marker" },
            BOUNDS
          )
        ).toThrow(/duplicate next-id/i);
      }
    );

    withTempWorkspace(
      (workspace) => {
        writeIndex(
          workspace,
          minimalIndex({
            next: "b42",
            backlog: [`- **b42** Already taken — stays.`],
          })
        );
      },
      (workspace) => {
        expect(() =>
          resolveImplementFullyKickoff(
            workspace,
            { kind: "idea", idea: "stale marker" },
            BOUNDS
          )
        ).toThrow(/already allocated/i);
      }
    );

    withTempWorkspace(
      (workspace) => {
        writeIndex(workspace, minimalIndex({ next: "b88" }));
      },
      (workspace) => {
        expect(() =>
          resolveImplementFullyKickoff(
            workspace,
            { kind: "idea", idea: "!!! ???" },
            BOUNDS
          )
        ).toThrow(/Cannot derive a feature slug/i);
        expect(() =>
          resolveImplementFullyKickoff(
            workspace,
            { kind: "idea", idea: "   " },
            BOUNDS
          )
        ).toThrow(/non-empty/i);
        const over = "x".repeat(CHAIN_VALUE_MAX_LENGTH + 1);
        expect(() =>
          resolveImplementFullyKickoff(
            workspace,
            { kind: "idea", idea: over },
            BOUNDS
          )
        ).toThrow(new RegExp(`${CHAIN_VALUE_MAX_LENGTH}`));
        // Multibyte input is measured in UTF-8 bytes, not characters.
        const overMultibyte = "é".repeat(CHAIN_VALUE_MAX_LENGTH);
        expect(() =>
          resolveImplementFullyKickoff(
            workspace,
            { kind: "idea", idea: overMultibyte },
            BOUNDS
          )
        ).toThrow(new RegExp(`${CHAIN_VALUE_MAX_LENGTH * 2} bytes`));
      }
    );
  });
});

describe("b42.1 POST /api/pipelines/:id/resolve", () => {
  it("returns the resolved triple for a valid feature-id request", async () => {
    await withServer(
      {
        workspaceFiles: (workspace) => {
          writeIndex(
            workspace,
            minimalIndex({
              backlog: [
                `- **b42** Thinner kickoff — resolve path. — [docs](./b42-thinner-impl-fully/00-index.md)`,
              ],
            })
          );
          mkdirSync(
            join(workspace, "docs", "roadmap", "b42-thinner-impl-fully"),
            { recursive: true }
          );
          writeFileSync(
            join(
              workspace,
              "docs",
              "roadmap",
              "b42-thinner-impl-fully",
              "00-index.md"
            ),
            "# b42\n"
          );
        },
      },
      async ({ base, workspaceId, workspace, db }) => {
        const res = await fetch(
          `${base}/api/pipelines/${IMPLEMENT_FULLY_PIPELINE_ID}/resolve`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceId,
              input: { kind: "feature-id", featureId: "b42" },
            }),
          }
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          featureId: string;
          featureSlug: string;
          idea: string;
        };
        expect(body).toEqual({
          featureId: "b42",
          featureSlug: "b42-thinner-impl-fully",
          idea: expect.stringContaining("Thinner kickoff"),
        });
        assertKickoffCompatible(
          body.featureId,
          body.featureSlug,
          body.idea
        );
        // No side effects: no runs, no automations, no new roadmap files.
        expect(
          (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number })
            .n
        ).toBe(0);
        expect(
          (
            db
              .prepare("SELECT COUNT(*) AS n FROM automations")
              .get() as { n: number }
          ).n
        ).toBe(0);
        expect(
          readdirSync(join(workspace, "docs", "roadmap")).sort()
        ).toEqual(["00-index.md", "b42-thinner-impl-fully"]);
      }
    );
  });

  it("maps unknown pipeline, workspace, git, index, body, and resolver errors", async () => {
    await withServer(
      {
        workspaceFiles: (workspace) => {
          writeIndex(
            workspace,
            minimalIndex({
              next: "b42",
              backlog: [`- **b42** Taken — x.`],
            })
          );
        },
      },
      async ({ base, workspaceId }) => {
        const unknownPipeline = await fetch(
          `${base}/api/pipelines/nope/resolve`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceId,
              input: { kind: "idea", idea: "x" },
            }),
          }
        );
        expect(unknownPipeline.status).toBe(404);

        const unknownWs = await fetch(
          `${base}/api/pipelines/${IMPLEMENT_FULLY_PIPELINE_ID}/resolve`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceId: "missing",
              input: { kind: "idea", idea: "x" },
            }),
          }
        );
        expect(unknownWs.status).toBe(404);

        const globalWs = await fetch(
          `${base}/api/pipelines/${IMPLEMENT_FULLY_PIPELINE_ID}/resolve`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceId: "__global__",
              input: { kind: "idea", idea: "x" },
            }),
          }
        );
        expect(globalWs.status).toBe(400);

        const badBody = await fetch(
          `${base}/api/pipelines/${IMPLEMENT_FULLY_PIPELINE_ID}/resolve`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceId,
              input: { kind: "feature-id", featureId: "nope" },
            }),
          }
        );
        expect(badBody.status).toBe(400);

        const stale = await fetch(
          `${base}/api/pipelines/${IMPLEMENT_FULLY_PIPELINE_ID}/resolve`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceId,
              input: { kind: "idea", idea: "stale" },
            }),
          }
        );
        expect(stale.status).toBe(400);
        const staleBody = (await stale.json()) as { error: string };
        expect(staleBody.error).toMatch(/already allocated/i);

        const missingFeature = await fetch(
          `${base}/api/pipelines/${IMPLEMENT_FULLY_PIPELINE_ID}/resolve`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceId,
              input: { kind: "feature-id", featureId: "b77" },
            }),
          }
        );
        expect(missingFeature.status).toBe(404);
      }
    );

    await withServer(
      {
        withGit: false,
        workspaceFiles: (workspace) => {
          writeIndex(workspace, minimalIndex({ next: "b90" }));
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
              input: { kind: "idea", idea: "needs git" },
            }),
          }
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toMatch(/git/i);
      }
    );

    await withServer(
      {
        workspaceFiles: (workspace) => {
          mkdirSync(join(workspace, "docs"), { recursive: true });
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
});
