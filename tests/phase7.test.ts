import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:os");
  delete process.env.LCA_MAX_CONCURRENT;
  delete process.env.LCA_EVENT_RETENTION;
  delete process.env.LCA_MAX_EVENT_BYTES;
});

function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("until() timed out"));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("file-watch glob matching", () => {
  it("matches workspace-relative paths and rejects out-of-tree/non-matching", async () => {
    const { matchesGlobs, relativeForMatch } = await import(
      "../packages/daemon/src/triggers/file-watch.ts"
    );
    const ws = process.platform === "win32" ? "C:\\repo" : "/repo";

    expect(matchesGlobs(ws, ["src/**/*.ts"], join(ws, "src", "a", "b.ts"))).toBe(
      true
    );
    expect(matchesGlobs(ws, ["src/**/*.ts"], join(ws, "src", "a", "b.js"))).toBe(
      false
    );
    expect(matchesGlobs(ws, ["**/*.md"], join(ws, "README.md"))).toBe(true);
    // A path outside the workspace never matches.
    const outside = process.platform === "win32" ? "C:\\other\\x.ts" : "/other/x.ts";
    expect(matchesGlobs(ws, ["**/*.ts"], outside)).toBe(false);
    expect(relativeForMatch(ws, outside)).toBe("");
  });
});

describe("git hook upsertBlock idempotency", () => {
  function setupRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "lca-githook-"));
    mkdirSync(join(dir, ".git"), { recursive: true });
    return dir;
  }

  it("is idempotent across repeated installs", async () => {
    const { installGitHooksForWorkspace } = await import(
      "../packages/daemon/src/triggers/git-install.ts"
    );
    const repo = setupRepo();
    try {
      const first = installGitHooksForWorkspace(repo, 3747);
      expect(first.length).toBeGreaterThan(0);
      expect(first.every((r) => r.created)).toBe(true);

      const postCommit = join(repo, ".git", "hooks", "post-commit");
      const afterFirst = readFileSync(postCommit, "utf8");

      const second = installGitHooksForWorkspace(repo, 3747);
      expect(second.every((r) => !r.created && !r.updated)).toBe(true);
      expect(readFileSync(postCommit, "utf8")).toBe(afterFirst);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("appends to an existing hook without clobbering prior content", async () => {
    const { installGitHooksForWorkspace, LCA_GIT_MARKER_BEGIN } = await import(
      "../packages/daemon/src/triggers/git-install.ts"
    );
    const repo = setupRepo();
    try {
      const hooksDir = join(repo, ".git", "hooks");
      mkdirSync(hooksDir, { recursive: true });
      const postCommit = join(hooksDir, "post-commit");
      writeFileSync(postCommit, "#!/bin/sh\necho custom-hook\n", "utf8");

      installGitHooksForWorkspace(repo, 3747);
      const content = readFileSync(postCommit, "utf8");
      expect(content).toContain("echo custom-hook");
      expect(content).toContain(LCA_GIT_MARKER_BEGIN);

      // Re-running keeps a single managed block (no duplication).
      installGitHooksForWorkspace(repo, 3747);
      const again = readFileSync(postCommit, "utf8");
      const markerCount = again.split(LCA_GIT_MARKER_BEGIN).length - 1;
      expect(markerCount).toBe(1);
      expect(again).toContain("echo custom-hook");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("daemon settings resolution", () => {
  it("applies env > file > default precedence and clamps to safe floors", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-settings-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));

    const { GLOBAL_CONFIG_PATH } = await import(
      "../packages/daemon/src/paths.ts"
    );
    mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    writeFileSync(
      GLOBAL_CONFIG_PATH,
      `settings:\n  maxConcurrentRuns: 5\n  eventRetentionPerRun: 10\n`,
      "utf8"
    );

    const { loadSettings, DEFAULT_SETTINGS } = await import(
      "../packages/daemon/src/config/settings.ts"
    );

    // Env overrides the file value.
    process.env.LCA_MAX_CONCURRENT = "2";
    const resolved = loadSettings();
    try {
      expect(resolved.maxConcurrentRuns).toBe(2);
      // File value below the floor is clamped up to the minimum retention.
      expect(resolved.eventRetentionPerRun).toBe(50);
      // Unset key falls back to default.
      expect(resolved.maxEventPayloadBytes).toBe(
        DEFAULT_SETTINGS.maxEventPayloadBytes
      );
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("ignores a malformed settings block without throwing", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-settings-bad-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));

    const { GLOBAL_CONFIG_PATH } = await import(
      "../packages/daemon/src/paths.ts"
    );
    mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    writeFileSync(
      GLOBAL_CONFIG_PATH,
      `settings:\n  maxConcurrency: 9\n`,
      "utf8"
    );

    const { loadSettings, DEFAULT_SETTINGS } = await import(
      "../packages/daemon/src/config/settings.ts"
    );

    const warnings: string[] = [];
    const resolved = loadSettings({ onLog: (m) => warnings.push(m) });
    try {
      expect(resolved.maxConcurrentRuns).toBe(DEFAULT_SETTINGS.maxConcurrentRuns);
      expect(warnings.some((w) => /Settings ignored/.test(w))).toBe(true);
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});

describe("run_events retention and payload cap", () => {
  function seedRun(db: import("better-sqlite3").Database): string {
    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES ('ws', '/repo', 'Repo')"
    ).run();
    db.prepare(
      `INSERT INTO automations (
        id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
      ) VALUES ('auto', 'ws', 'A', 1, 'enabled', '{"type":"manual"}', 'Run', 'c.yaml', 'auto')`
    ).run();
    db.prepare(
      `INSERT INTO runs (id, automation_id, workspace_id, status, trigger_kind, prompt)
       VALUES ('run', 'auto', 'ws', 'completed', 'manual', 'Run')`
    ).run();
    return "run";
  }

  it("truncates oversized payloads to a valid-JSON summary", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-cap-"));
    const { openDatabase } = await import("../packages/daemon/src/db/index.ts");
    const { RunStore } = await import("../packages/daemon/src/runs/store.ts");
    const db = openDatabase(join(testHome, "state.sqlite"));
    try {
      const runId = seedRun(db);
      const store = new RunStore(db, undefined, { maxEventPayloadBytes: 200 });
      store.appendEvent(runId, "assistant", { text: "x".repeat(5000) });

      const [event] = store.listRunEvents(runId);
      const parsed = JSON.parse(event.payload) as Record<string, unknown>;
      expect(parsed._truncated).toBe(true);
      expect(parsed.eventType).toBe("assistant");
      expect(Number(parsed.originalBytes)).toBeGreaterThan(200);
    } finally {
      db.close();
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("prunes the oldest events past the retention cap", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-prune-"));
    const { openDatabase } = await import("../packages/daemon/src/db/index.ts");
    const { RunStore } = await import("../packages/daemon/src/runs/store.ts");
    const db = openDatabase(join(testHome, "state.sqlite"));
    try {
      const runId = seedRun(db);
      const store = new RunStore(db);
      for (let i = 0; i < 10; i++) {
        store.appendEvent(runId, "tick", { i });
      }
      const removed = store.pruneRunEvents(runId, 3);
      expect(removed).toBe(7);

      const remaining = store.listRunEvents(runId);
      expect(remaining).toHaveLength(3);
      // The most recent events survive (highest seq numbers).
      expect(remaining.map((e) => e.seq)).toEqual([8, 9, 10]);
    } finally {
      db.close();
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});

describe("run history export", () => {
  it("formats CSV with header and RFC-4180 escaping", async () => {
    const { runsToCsv } = await import("../packages/daemon/src/http/export.ts");
    const csv = runsToCsv([
      {
        id: "r1",
        automationId: "a1",
        automationName: 'Nightly, "review"',
        workspaceId: "ws1",
        workspacePath: "/repo",
        status: "completed",
        triggerKind: "manual",
        createdAt: "2026-01-01 00:00:00",
        startedAt: "2026-01-01 00:00:01",
        endedAt: "2026-01-01 00:00:05",
        eventCount: 3,
      },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "id,automationId,automationName,workspaceId,workspacePath,status,triggerKind,createdAt,startedAt,endedAt,eventCount"
    );
    // The comma+quote cell is wrapped in quotes with doubled inner quotes.
    expect(lines[1]).toContain('"Nightly, ""review"""');
  });

  it("exports enriched, workspace-filtered run rows from the store", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-export-"));
    const { openDatabase } = await import("../packages/daemon/src/db/index.ts");
    const { DashboardStore } = await import(
      "../packages/daemon/src/http/dashboard-store.ts"
    );
    const db = openDatabase(join(testHome, "state.sqlite"));
    try {
      db.prepare(
        "INSERT INTO workspaces (id, path, name) VALUES ('ws1', '/repo1', 'One'), ('ws2', '/repo2', 'Two')"
      ).run();
      db.prepare(
        `INSERT INTO automations (id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key)
         VALUES ('a1', 'ws1', 'Auto One', 1, 'enabled', '{"type":"manual"}', 'p', 'c.yaml', 'a1'),
                ('a2', 'ws2', 'Auto Two', 1, 'enabled', '{"type":"manual"}', 'p', 'c.yaml', 'a2')`
      ).run();
      db.prepare(
        `INSERT INTO runs (id, automation_id, workspace_id, status, trigger_kind, prompt)
         VALUES ('run1', 'a1', 'ws1', 'completed', 'manual', 'p'),
                ('run2', 'a2', 'ws2', 'failed', 'cron', 'p')`
      ).run();
      db.prepare(
        "INSERT INTO run_events (run_id, seq, event_type, payload) VALUES ('run1', 1, 'x', '{}')"
      ).run();

      const store = new DashboardStore(db);
      const all = store.exportRuns();
      expect(all).toHaveLength(2);

      const scoped = store.exportRuns({ workspaceId: "ws1" });
      expect(scoped).toHaveLength(1);
      expect(scoped[0].automationName).toBe("Auto One");
      expect(scoped[0].workspacePath).toBe("/repo1");
      expect(scoped[0].eventCount).toBe(1);
    } finally {
      db.close();
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});

describe("run token verification", () => {
  it("rejects asks with a missing or wrong per-run token", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-token-"));
    const { openDatabase } = await import("../packages/daemon/src/db/index.ts");
    const { RunEngine } = await import("../packages/daemon/src/runs/engine.ts");
    const db = openDatabase(join(testHome, "state.sqlite"));
    try {
      const engine = new RunEngine(db, {
        apiKey: "test",
        executor: {} as never,
        inputHub: {} as never,
      });
      const tokens = (engine as unknown as { runTokens: Map<string, string> })
        .runTokens;
      tokens.set("run", "secret");

      expect(() => engine.verifyRunToken("run", "secret")).not.toThrow();
      expect(() => engine.verifyRunToken("run", "wrong")).toThrow(/run token/i);
      expect(() => engine.verifyRunToken("run", undefined)).toThrow(/run token/i);
      // No token registered → no enforcement (e.g. legacy/sentinel path).
      expect(() => engine.verifyRunToken("other", undefined)).not.toThrow();
    } finally {
      db.close();
      rmSync(testHome, { recursive: true, force: true });
    }
    // afterEach resets modules; cold-importing RunEngine regularly exceeds 10s.
  }, 30_000);
});

describe("concurrency cap and queueing", () => {
  it("holds excess runs in queued until a slot frees, then drains in order", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-concurrency-"));
    const { openDatabase } = await import("../packages/daemon/src/db/index.ts");
    const { RunEngine } = await import("../packages/daemon/src/runs/engine.ts");
    const db = openDatabase(join(testHome, "state.sqlite"));
    try {
      db.prepare(
        "INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Repo')"
      ).run(testHome);
      db.prepare(
        `INSERT INTO automations (id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key)
         VALUES ('auto', 'ws', 'A', 1, 'enabled', '{"type":"manual"}', 'Run', 'c.yaml', 'auto')`
      ).run();

      const releases: Array<() => void> = [];
      const executor = {
        kind: "sdk-local" as const,
        async spawn() {
          const idx = releases.length;
          let release!: () => void;
          const gate = new Promise<void>((r) => (release = r));
          releases.push(release);
          return {
            kind: "sdk-local" as const,
            agentId: `agent-${idx}`,
            sdkRunId: `sdk-${idx}`,
            async *stream() {
              await gate;
            },
            wait: async () => ({ status: "finished" as const, result: null }),
            cancel: async () => undefined,
            dispose: async () => undefined,
          };
        },
        async resume() {
          throw new Error("resume not used in this test");
        },
      };

      const engine = new RunEngine(db, {
        apiKey: "test",
        executor: executor as never,
        inputHub: {} as never,
        maxConcurrentRuns: 1,
      });

      const runA = await engine.triggerRun("auto", "manual");
      const runB = await engine.triggerRun("auto", "manual");

      const status = (id: string) =>
        (
          db.prepare("SELECT status FROM runs WHERE id = ?").get(id) as {
            status: string;
          }
        ).status;

      // Cap = 1: A runs, B waits in the queue.
      await until(() => status(runA) === "running");
      expect(status(runB)).toBe("queued");

      // Finishing A frees the only slot; the pump starts B next.
      releases[0]();
      await until(() => status(runA) === "completed");
      await until(() => status(runB) === "running");

      releases[1]();
      await until(() => status(runB) === "completed");
    } finally {
      db.close();
      rmSync(testHome, { recursive: true, force: true });
    }
  }, 15_000);
});
