import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:os");
});

describe("workspace chat defaults config pipeline", () => {
  it("parseWorkspaceChatDefaults soft-fails malformed files", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b28-6b-parse-"));
    const filePath = join(testHome, "chat.yaml");
    writeFileSync(filePath, "model: [invalid", "utf8");

    const { parseWorkspaceChatDefaults } = await import(
      "../packages/daemon/src/config/parse.ts"
    );
    const warnings: string[] = [];
    const result = parseWorkspaceChatDefaults(filePath, {
      onWarning: (message) => warnings.push(message),
    });

    expect(result).toBeNull();
    expect(warnings.some((w) => w.includes("Skipping"))).toBe(true);
    rmSync(testHome, { recursive: true, force: true });
  });

  it("reconcile upserts and clears workspace chat defaults from chat.yaml", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b28-6b-reconcile-"));
    const workspace = join(testHome, "workspace");

    vi.resetModules();
    vi.doMock("node:os", () => ({
      homedir: () => testHome,
    }));

    const { openDatabase } = await import("../packages/daemon/src/db/index.ts");
    const { reconcileConfig } = await import(
      "../packages/daemon/src/config/reconcile.ts"
    );
    const { GLOBAL_CONFIG_PATH, workspaceChatConfigPath } = await import(
      "../packages/daemon/src/paths.ts"
    );

    mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(
      GLOBAL_CONFIG_PATH,
      `workspaces:\n  - ${workspace.replace(/\\/g, "/")}\n`,
      "utf8"
    );

    const chatPath = workspaceChatConfigPath(workspace);
    mkdirSync(dirname(chatPath), { recursive: true });
    writeFileSync(
      chatPath,
      `model: gpt-5.5\nsystemPrompt: Hello world\nmcp:\n  disable:\n    - filesystem\n`,
      "utf8"
    );

    const db = openDatabase(join(testHome, "state.sqlite"));
    try {
      reconcileConfig(db);

      const row = db
        .prepare(
          `SELECT model, system_prompt, mcp_overlay_json FROM workspace_chat_defaults`
        )
        .get() as {
        model: string | null;
        system_prompt: string | null;
        mcp_overlay_json: string;
      };

      expect(row.model).toBe("gpt-5.5");
      expect(row.system_prompt).toBe("Hello world");
      expect(JSON.parse(row.mcp_overlay_json)).toEqual({
        disable: ["filesystem"],
      });

      unlinkSync(chatPath);
      reconcileConfig(db);

      const cleared = db
        .prepare(`SELECT COUNT(*) AS n FROM workspace_chat_defaults`)
        .get() as { n: number };
      expect(cleared.n).toBe(0);
    } finally {
      db.close();
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("writeWorkspaceChatDefaults round-trips through reconcile", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b28-6b-write-"));
    const workspace = join(testHome, "workspace");

    vi.resetModules();
    vi.doMock("node:os", () => ({
      homedir: () => testHome,
    }));

    const { openDatabase } = await import("../packages/daemon/src/db/index.ts");
    const { reconcileConfig } = await import(
      "../packages/daemon/src/config/reconcile.ts"
    );
    const { writeWorkspaceChatDefaults } = await import(
      "../packages/daemon/src/config/write.ts"
    );
    const { GLOBAL_CONFIG_PATH } = await import("../packages/daemon/src/paths.ts");

    mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(
      GLOBAL_CONFIG_PATH,
      `workspaces:\n  - ${workspace.replace(/\\/g, "/")}\n`,
      "utf8"
    );

    writeWorkspaceChatDefaults(workspace, {
      model: "claude-4",
      systemPrompt: "Be concise",
      mcp: { disable: ["playwright"] },
    });

    const db = openDatabase(join(testHome, "state.sqlite"));
    try {
      reconcileConfig(db);

      const row = db
        .prepare(
          `SELECT model, system_prompt, mcp_overlay_json FROM workspace_chat_defaults`
        )
        .get() as {
        model: string | null;
        system_prompt: string | null;
        mcp_overlay_json: string;
      };

      expect(row.model).toBe("claude-4");
      expect(row.system_prompt).toBe("Be concise");
      expect(JSON.parse(row.mcp_overlay_json)).toEqual({
        disable: ["playwright"],
      });
    } finally {
      db.close();
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("parses structured model selections from chat.yaml", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b35-parse-model-"));
    const filePath = join(testHome, "chat.yaml");
    writeFileSync(
      filePath,
      `model:\n  id: grok-4.5\n  params:\n    - id: reasoning_effort\n      value: high\n    - id: fast\n      value: "true"\n`,
      "utf8"
    );

    const { parseWorkspaceChatDefaults } = await import(
      "../packages/daemon/src/config/parse.ts"
    );
    const result = parseWorkspaceChatDefaults(filePath);
    expect(result?.model).toEqual({
      id: "grok-4.5",
      params: [
        { id: "fast", value: "true" },
        { id: "reasoning_effort", value: "high" },
      ],
    });
    rmSync(testHome, { recursive: true, force: true });
  });

  it("write/reconcile round-trips parameterized model YAML and clears params", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b35-write-model-"));
    const workspace = join(testHome, "workspace");

    vi.resetModules();
    vi.doMock("node:os", () => ({
      homedir: () => testHome,
    }));

    const { openDatabase } = await import("../packages/daemon/src/db/index.ts");
    const { reconcileConfig } = await import(
      "../packages/daemon/src/config/reconcile.ts"
    );
    const { writeWorkspaceChatDefaults } = await import(
      "../packages/daemon/src/config/write.ts"
    );
    const { GLOBAL_CONFIG_PATH, workspaceChatConfigPath } = await import(
      "../packages/daemon/src/paths.ts"
    );
    const { readFileSync } = await import("node:fs");

    mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(
      GLOBAL_CONFIG_PATH,
      `workspaces:\n  - ${workspace.replace(/\\/g, "/")}\n`,
      "utf8"
    );

    writeWorkspaceChatDefaults(workspace, {
      model: {
        id: "grok-4.5",
        params: [
          { id: "reasoning_effort", value: "high" },
          { id: "fast", value: "true" },
        ],
      },
      systemPrompt: "Keep params",
    });

    const yaml = readFileSync(workspaceChatConfigPath(workspace), "utf8");
    expect(yaml).toContain("id: grok-4.5");
    expect(yaml).toContain("reasoning_effort");
    expect(yaml).toContain("fast");

    const db = openDatabase(join(testHome, "state.sqlite"));
    try {
      reconcileConfig(db);
      const row = db
        .prepare(
          `SELECT model, model_params_json FROM workspace_chat_defaults`
        )
        .get() as {
        model: string | null;
        model_params_json: string | null;
      };
      expect(row.model).toBe("grok-4.5");
      expect(JSON.parse(row.model_params_json!)).toEqual([
        { id: "fast", value: "true" },
        { id: "reasoning_effort", value: "high" },
      ]);

      // Scalar rewrite after parameterized must clear params
      writeWorkspaceChatDefaults(workspace, { model: "composer-2.5" });
      reconcileConfig(db);
      const scalar = db
        .prepare(
          `SELECT model, model_params_json FROM workspace_chat_defaults`
        )
        .get() as {
        model: string | null;
        model_params_json: string | null;
      };
      expect(scalar.model).toBe("composer-2.5");
      expect(scalar.model_params_json).toBeNull();

      const scalarYaml = readFileSync(
        workspaceChatConfigPath(workspace),
        "utf8"
      );
      expect(scalarYaml).toMatch(/model:\s*composer-2\.5/);
      expect(scalarYaml).not.toContain("params:");
    } finally {
      db.close();
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("reconcile persists structured automation model selections", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b35-auto-model-"));
    const workspace = join(testHome, "workspace");

    vi.resetModules();
    vi.doMock("node:os", () => ({
      homedir: () => testHome,
    }));

    const { openDatabase } = await import("../packages/daemon/src/db/index.ts");
    const { reconcileConfig } = await import(
      "../packages/daemon/src/config/reconcile.ts"
    );
    const { GLOBAL_CONFIG_PATH, workspaceAutomationsDir } = await import(
      "../packages/daemon/src/paths.ts"
    );

    mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    mkdirSync(workspaceAutomationsDir(workspace), { recursive: true });
    writeFileSync(
      GLOBAL_CONFIG_PATH,
      `workspaces:\n  - ${workspace.replace(/\\/g, "/")}\n`,
      "utf8"
    );
    writeFileSync(
      join(workspaceAutomationsDir(workspace), "demo.yaml"),
      `automations:
  - id: demo
    name: Demo
    enabled: true
    trigger:
      type: manual
    prompt: hello
    model:
      id: grok-4.5
      params:
        - id: reasoning_effort
          value: medium
`,
      "utf8"
    );

    const db = openDatabase(join(testHome, "state.sqlite"));
    try {
      reconcileConfig(db);
      const row = db
        .prepare(
          `SELECT model, model_params_json FROM automations WHERE config_key = 'demo'`
        )
        .get() as {
        model: string | null;
        model_params_json: string | null;
      };
      expect(row.model).toBe("grok-4.5");
      expect(JSON.parse(row.model_params_json!)).toEqual([
        { id: "reasoning_effort", value: "medium" },
      ]);
    } finally {
      db.close();
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});
