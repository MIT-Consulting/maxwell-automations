import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@lca/shared";
import { DaemonClient, DaemonError } from "../packages/cli/src/client.ts";
import { cmdWorkspace } from "../packages/cli/src/cli.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..");
const CLI_INDEX = join(REPO_ROOT, "packages", "cli", "src", "cli.ts");

function helpBlock(): string {
  const helpSrc = readFileSync(CLI_INDEX, "utf8");
  return helpSrc.slice(
    helpSrc.indexOf("function printHelp"),
    helpSrc.indexOf("async function main")
  );
}

function mockJsonResponse(
  status: number,
  body: unknown,
  statusText = status === 201 ? "Created" : "Error"
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  } as Response;
}

describe("DaemonClient.createWorkspace", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs JSON to /api/workspaces and returns workspace", async () => {
    const workspace: Workspace = {
      id: "ws-new",
      path: "C:\\resolved\\repo",
      name: "repo",
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockJsonResponse(201, { workspace })
    );
    const client = new DaemonClient("http://127.0.0.1:59998");

    const result = await client.createWorkspace({ path: "C:\\input\\repo" });

    expect(result).toEqual(workspace);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:59998/api/workspaces",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ path: "C:\\input\\repo" }),
      })
    );
  });

  it("propagates daemon 400 through DaemonError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockJsonResponse(400, {
        error: "Path does not exist on disk: C:\\missing",
      })
    );
    const client = new DaemonClient("http://127.0.0.1:59998");

    await expect(
      client.createWorkspace({ path: "C:\\missing" })
    ).rejects.toThrow(DaemonError);
    await expect(
      client.createWorkspace({ path: "C:\\missing" })
    ).rejects.toThrow(/400.*Path does not exist on disk/);
  });

  it("propagates daemon 409 through DaemonError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockJsonResponse(409, {
        error: "Workspace already registered: C:\\repo",
      })
    );
    const client = new DaemonClient("http://127.0.0.1:59998");

    await expect(client.createWorkspace({ path: "C:\\repo" })).rejects.toThrow(
      DaemonError
    );
    await expect(client.createWorkspace({ path: "C:\\repo" })).rejects.toThrow(
      /409.*Workspace already registered/
    );
  });
});

describe("max workspace add CLI contract", () => {
  const usage = "Usage: max workspace add <path>";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("documents the command in help", () => {
    const block = helpBlock();
    expect(block).toContain("max workspace add <path>");
  });

  it("dispatches workspace add through main switch", () => {
    const mainSrc = readFileSync(CLI_INDEX, "utf8");
    expect(mainSrc).toContain('case "workspace":');
    expect(mainSrc).toContain("await cmdWorkspace(client, rest);");
  });

  it("prints daemon-returned id and path on success", async () => {
    class StubClient extends DaemonClient {
      override async createWorkspace(): Promise<Workspace> {
        return {
          id: "ws-abc",
          path: "/daemon/resolved/path",
          name: "path",
        };
      }
    }
    const client = new StubClient("http://127.0.0.1:1");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg));
    });

    await cmdWorkspace(client, ["add", "relative/path"]);

    expect(logs.join("\n")).toContain("ws-abc");
    expect(logs.join("\n")).toContain("/daemon/resolved/path");
  });

  it("rejects missing subcommand, path, and extra arguments", async () => {
    const client = new DaemonClient("http://127.0.0.1:1");

    await expect(cmdWorkspace(client, [])).rejects.toThrow(usage);
    await expect(cmdWorkspace(client, ["add"])).rejects.toThrow(usage);
    await expect(cmdWorkspace(client, ["add", " ", "extra"])).rejects.toThrow(
      usage
    );
    await expect(cmdWorkspace(client, ["add", "path", "extra"])).rejects.toThrow(
      usage
    );
    await expect(cmdWorkspace(client, ["remove", "path"])).rejects.toThrow(usage);
  });
});
