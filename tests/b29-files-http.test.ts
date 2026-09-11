import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import type { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { freeListenPort } from "./helpers/free-port.ts";

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
      throw new Error("spawn not expected in HTTP tests");
    },
    resume: async () => {
      throw new Error("resume not expected in HTTP tests");
    },
  };
}

function stubRunEngine(): RunEngine {
  return {} as unknown as RunEngine;
}

async function withServer(
  opts: {
    workspaceFiles?: (workspace: string) => void;
    settings?: typeof DEFAULT_SETTINGS;
  },
  run: (ctx: {
    base: string;
    workspace: string;
    workspaceId: string;
  }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "lca-b29-files-"));
  const db = openDatabase(join(root, "state.sqlite"));
  const workspace = join(root, "workspace");
  const workspaceId = "ws";
  seedWorkspace(db, workspace, workspaceId);
  opts.workspaceFiles?.(workspace);
  // OS-assigned port — randomPort(54xxx) hit Windows excluded ranges (EACCES).
  const port = await freeListenPort();
  const chatEngine = new ChatEngine(db, {
    apiKey: "test",
    executor: noopExecutor(),
  });
  const http = await startHttpServer({
    engine: stubRunEngine(),
    chatEngine,
    store: new DashboardStore(db),
    db,
    events: new DaemonEventBus(),
    apiKey: "test",
    settings: opts.settings ?? DEFAULT_SETTINGS,
    port,
  });
  try {
    await run({
      base: `http://127.0.0.1:${port}`,
      workspace,
      workspaceId,
    });
  } finally {
    await http.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("b29 file viewer HTTP", () => {
  it("lists root dirs-first A→Z with forward-slash names", async () => {
    await withServer(
      {
        workspaceFiles: (workspace) => {
          mkdirSync(join(workspace, "docs"), { recursive: true });
          mkdirSync(join(workspace, "src"), { recursive: true });
          writeFileSync(join(workspace, "README.md"), "# hi\n");
          writeFileSync(join(workspace, "a.txt"), "a");
        },
      },
      async ({ base, workspaceId }) => {
        const res = await fetch(
          `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/files`
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          dir: string;
          entries: Array<{ name: string; kind: string }>;
          truncated: boolean;
        };
        expect(body.dir).toBe("");
        expect(body.truncated).toBe(false);
        expect(body.entries.map((e) => e.name)).toEqual([
          "docs",
          "src",
          "a.txt",
          "README.md",
        ]);
        expect(body.entries.map((e) => e.kind)).toEqual([
          "dir",
          "dir",
          "file",
          "file",
        ]);
      }
    );
  });

  it("lists a subdirectory via ?dir=", async () => {
    await withServer(
      {
        workspaceFiles: (workspace) => {
          mkdirSync(join(workspace, "sub"), { recursive: true });
          writeFileSync(join(workspace, "sub", "note.md"), "n");
        },
      },
      async ({ base, workspaceId }) => {
        const res = await fetch(
          `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/files?dir=${encodeURIComponent("sub")}`
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          dir: string;
          entries: Array<{ name: string }>;
        };
        expect(body.dir).toBe("sub");
        expect(body.entries.map((e) => e.name)).toEqual(["note.md"]);
      }
    );
  });

  it("sets truncated when entry cap is hit", async () => {
    await withServer(
      {
        settings: { ...DEFAULT_SETTINGS, maxFileViewerEntries: 50 },
        workspaceFiles: (workspace) => {
          for (let i = 0; i < 60; i++) {
            writeFileSync(
              join(workspace, `f${String(i).padStart(2, "0")}.txt`),
              "x"
            );
          }
        },
      },
      async ({ base, workspaceId }) => {
        const res = await fetch(
          `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/files`
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          entries: unknown[];
          truncated: boolean;
        };
        expect(body.truncated).toBe(true);
        expect(body.entries).toHaveLength(50);
      }
    );
  });

  it("rejects listing .git and nested .git paths", async () => {
    await withServer(
      {
        workspaceFiles: (workspace) => {
          mkdirSync(join(workspace, ".git", "objects"), { recursive: true });
        },
      },
      async ({ base, workspaceId }) => {
        for (const dir of [".git", ".git/objects"]) {
          const res = await fetch(
            `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/files?dir=${encodeURIComponent(dir)}`
          );
          expect(res.status).toBe(400);
          const body = (await res.json()) as { error: string };
          expect(body.error).toMatch(/git|node_modules/i);
        }
      }
    );
  });

  it("returns utf8 markdown content", async () => {
    const markdown = "# Plan\n\n- one\n";
    await withServer(
      {
        workspaceFiles: (workspace) => {
          mkdirSync(join(workspace, "docs"), { recursive: true });
          writeFileSync(join(workspace, "docs", "plan.md"), markdown);
        },
      },
      async ({ base, workspaceId }) => {
        const res = await fetch(
          `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent("docs/plan.md")}`
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          path: string;
          encoding: string;
          content: string | null;
          truncated: boolean;
        };
        expect(body.path).toBe("docs/plan.md");
        expect(body.encoding).toBe("utf8");
        expect(body.content).toBe(markdown);
        expect(body.truncated).toBe(false);
      }
    );
  });

  it("truncates oversize text and reports true size", async () => {
    const maxBytes = 64 * 1024;
    const payload = "a".repeat(maxBytes + 100);
    await withServer(
      {
        settings: { ...DEFAULT_SETTINGS, maxFileViewerBytes: maxBytes },
        workspaceFiles: (workspace) => {
          writeFileSync(join(workspace, "big.txt"), payload);
        },
      },
      async ({ base, workspaceId }) => {
        const res = await fetch(
          `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent("big.txt")}`
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          size: number;
          content: string | null;
          truncated: boolean;
          encoding: string;
        };
        expect(body.encoding).toBe("utf8");
        expect(body.truncated).toBe(true);
        expect(body.size).toBe(payload.length);
        expect(body.content).toBe(payload.slice(0, maxBytes));
      }
    );
  });

  it("returns binary metadata without content", async () => {
    await withServer(
      {
        workspaceFiles: (workspace) => {
          writeFileSync(join(workspace, "blob.bin"), Buffer.from([0, 1, 2, 3]));
        },
      },
      async ({ base, workspaceId }) => {
        const res = await fetch(
          `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent("blob.bin")}`
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          encoding: string;
          content: string | null;
        };
        expect(body.encoding).toBe("binary");
        expect(body.content).toBeNull();
      }
    );
  });

  it("rejects traversal probes without leaking content", async () => {
    await withServer(
      {
        workspaceFiles: (workspace) => {
          writeFileSync(join(workspace, "safe.txt"), "safe");
          writeFileSync(join(workspace, "..", "outside.txt"), "secret");
        },
      },
      async ({ base, workspaceId }) => {
        const probes = [
          "../outside.txt",
          "..%2F..%2Fetc%2Fpasswd",
          join(tmpdir(), "abs.txt"),
          "safe%00.txt",
        ];
        for (const path of probes) {
          const res = await fetch(
            `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/files/content?path=${path.includes("%") ? path : encodeURIComponent(path)}`
          );
          expect([400, 404]).toContain(res.status);
          const text = await res.text();
          expect(text).not.toContain("secret");
          expect(text).not.toMatch(/root:|passwd/i);
        }
      }
    );
  });

  it("rejects symlink escape when the platform allows symlinks", async () => {
    await withServer(
      {
        workspaceFiles: (workspace) => {
          const outside = join(workspace, "..", "outside-secret.txt");
          writeFileSync(outside, "secret-outside");
          try {
            symlinkSync(outside, join(workspace, "escape-link"));
          } catch (err) {
            console.warn(
              "skipping symlink escape case — platform refused symlink:",
              err
            );
          }
        },
      },
      async ({ base, workspace, workspaceId }) => {
        const linkPath = join(workspace, "escape-link");
        const { existsSync } = await import("node:fs");
        if (!existsSync(linkPath)) {
          return;
        }
        const res = await fetch(
          `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent("escape-link")}`
        );
        expect([400, 404]).toContain(res.status);
        const text = await res.text();
        expect(text).not.toContain("secret-outside");
      }
    );
  });

  it("404s unknown workspace and 400s directory content reads", async () => {
    await withServer(
      {
        workspaceFiles: (workspace) => {
          mkdirSync(join(workspace, "docs"), { recursive: true });
        },
      },
      async ({ base, workspaceId }) => {
        const missing = await fetch(
          `${base}/api/workspaces/${encodeURIComponent("no-such-ws")}/files`
        );
        expect(missing.status).toBe(404);

        const dirAsFile = await fetch(
          `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent("docs")}`
        );
        expect(dirAsFile.status).toBe(400);
      }
    );
  });
});
