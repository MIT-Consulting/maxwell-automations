import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  askRunInputSchema,
  inputRequestMetadataSchema,
  isValidInputArtifactPath,
  INPUT_ARTIFACTS_MAX,
  INPUT_ARTIFACT_LABEL_MAX_LENGTH,
  INPUT_CHOICES_MAX,
  INPUT_CHOICE_DESCRIPTION_MAX_LENGTH,
  INPUT_CHOICE_LABEL_MAX_LENGTH,
  INPUT_KIND_MAX_LENGTH,
  INPUT_METADATA_MAX_BYTES,
} from "../packages/shared/src/schemas/run.ts";
import { IMPLEMENT_FULLY_PIPELINE_ID } from "../packages/shared/src/types/api.ts";
import type { ChainVariables } from "../packages/shared/src/types/config.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { migrate } from "../packages/daemon/src/db/migrate.ts";
import { SCHEMA_VERSION } from "../packages/daemon/src/db/schema.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import {
  InputStore,
  parseInputMetadataJson,
  rowToInputRequest,
} from "../packages/daemon/src/input/store.ts";
import {
  computeImplementFullyBudget,
  IMPLEMENT_FULLY_WORKERS,
} from "../packages/daemon/src/pipelines/implement-fully.ts";
import { renderChainTemplate } from "../packages/daemon/src/runs/chain-template.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..");
const PROTOCOL_PATH = join(REPO_ROOT, "docs", "implement-fully-protocol.md");
const REFERENCE_PATH = join(
  REPO_ROOT,
  "skills",
  "implement-fully",
  "reference.md"
);

const BASE_VARIABLES: Omit<ChainVariables, "planningDepth" | "approvalPolicy"> =
  {
    pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
    featureId: "b45",
    featureSlug: "b45-configurable-implement-fully-planning",
    featureDir: "docs/roadmap/b45-configurable-implement-fully-planning",
    featureIndex:
      "docs/roadmap/b45-configurable-implement-fully-planning/00-index.md",
    idea: "Configurable implement-fully planning profiles",
    researchApprovalPolicy: "none",
    loopMode: "normal",
  };

function vars(
  planningDepth: "jit" | "full",
  approvalPolicy: "none" | "before-implementation" = "none"
): ChainVariables {
  return { ...BASE_VARIABLES, planningDepth, approvalPolicy };
}

function renderPlanPhase(
  planningDepth: "jit" | "full",
  approvalPolicy: "none" | "before-implementation" = "none"
): string {
  const worker = IMPLEMENT_FULLY_WORKERS.find((w) => w.key === "plan-phase");
  if (!worker) throw new Error("missing plan-phase worker");
  const rendered = renderChainTemplate(
    worker.prompt,
    vars(planningDepth, approvalPolicy)
  );
  expect(rendered.ok).toBe(true);
  if (!rendered.ok) throw new Error("render failed");
  return rendered.text;
}

function schemaVersion(db: ReturnType<typeof openDatabase>): number {
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null };
  return row.version ?? 0;
}

function hasColumn(
  db: ReturnType<typeof openDatabase>,
  table: string,
  name: string
): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return cols.some((c) => c.name === name);
}

const VALID_META = {
  kind: "approval",
  choices: [
    { id: "approve", label: "Approve" },
    { id: "revise", label: "Revise" },
    { id: "abort", label: "Abort" },
  ],
  recommendedChoiceId: "approve",
  artifacts: [
    {
      label: "PRD",
      path: "docs/roadmap/b45-configurable-implement-fully-planning/prd.md",
    },
  ],
};

describe("b45.4 structured input metadata schema", () => {
  it("accepts valid metadata and question-only ask bodies", () => {
    expect(inputRequestMetadataSchema.parse(VALID_META)).toMatchObject({
      kind: "approval",
      recommendedChoiceId: "approve",
    });
    expect(askRunInputSchema.parse({ question: "Proceed?" })).toEqual({
      question: "Proceed?",
    });
    expect(
      askRunInputSchema.parse({ question: "Proceed?", metadata: VALID_META })
    ).toMatchObject({ question: "Proceed?", metadata: { kind: "approval" } });
  });

  it("rejects duplicate choices, bad recommendations, unknown keys, and bad paths", () => {
    expect(
      inputRequestMetadataSchema.safeParse({
        kind: "approval",
        choices: [
          { id: "approve", label: "A" },
          { id: "approve", label: "B" },
        ],
      }).success
    ).toBe(false);
    expect(
      inputRequestMetadataSchema.safeParse({
        kind: "approval",
        choices: [{ id: "approve", label: "A" }],
        recommendedChoiceId: "missing",
      }).success
    ).toBe(false);
    expect(
      askRunInputSchema.safeParse({
        question: "x",
        metadata: VALID_META,
        extra: true,
      }).success
    ).toBe(false);
    expect(isValidInputArtifactPath("/abs/prd.md")).toBe(false);
    expect(isValidInputArtifactPath("docs\\prd.md")).toBe(false);
    expect(isValidInputArtifactPath("docs/../secret.md")).toBe(false);
    expect(isValidInputArtifactPath("docs/./prd.md")).toBe(false);
    expect(
      inputRequestMetadataSchema.safeParse({
        kind: "approval",
        artifacts: [{ label: "Bad", path: "../etc/passwd" }],
      }).success
    ).toBe(false);
  });

  it("bounds kind length, choice/artifact counts, and serialized size", () => {
    expect(
      inputRequestMetadataSchema.safeParse({
        kind: "a".repeat(INPUT_KIND_MAX_LENGTH + 1),
      }).success
    ).toBe(false);
    expect(
      inputRequestMetadataSchema.safeParse({
        kind: "approval",
        choices: Array.from({ length: INPUT_CHOICES_MAX + 1 }, (_, i) => ({
          id: `c${i}`,
          label: `Choice ${i}`,
        })),
      }).success
    ).toBe(false);
    expect(
      inputRequestMetadataSchema.safeParse({
        kind: "approval",
        artifacts: Array.from({ length: INPUT_ARTIFACTS_MAX + 1 }, (_, i) => ({
          label: `A${i}`,
          path: `docs/a${i}.md`,
        })),
      }).success
    ).toBe(false);

    // Within per-field bounds but over the serialized-payload ceiling.
    const oversized = {
      kind: "approval",
      choices: Array.from({ length: INPUT_CHOICES_MAX }, (_, i) => ({
        id: `c${i}`,
        label: "l".repeat(INPUT_CHOICE_LABEL_MAX_LENGTH),
        description: "d".repeat(INPUT_CHOICE_DESCRIPTION_MAX_LENGTH),
      })),
      artifacts: Array.from({ length: INPUT_ARTIFACTS_MAX }, (_, i) => ({
        label: "l".repeat(INPUT_ARTIFACT_LABEL_MAX_LENGTH),
        path: `docs/${"p".repeat(200)}/${i}.md`,
      })),
    };
    expect(JSON.stringify(oversized).length).toBeGreaterThan(
      INPUT_METADATA_MAX_BYTES
    );
    expect(inputRequestMetadataSchema.safeParse(oversized).success).toBe(false);
  });
});

describe("b45.4 schema v18 migration", () => {
  it("opens fresh databases with metadata_json at SCHEMA_VERSION", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b45-4-fresh-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(18);
      expect(hasColumn(db, "input_requests", "metadata_json")).toBe(true);
      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("upgrades from v17 and is idempotent for partial-column recovery", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b45-4-upgrade-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      db.exec("ALTER TABLE input_requests DROP COLUMN metadata_json");
      db.prepare("DELETE FROM schema_migrations WHERE version >= 18").run();
      expect(schemaVersion(db)).toBe(17);
      expect(hasColumn(db, "input_requests", "metadata_json")).toBe(false);

      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      expect(hasColumn(db, "input_requests", "metadata_json")).toBe(true);

      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      expect(hasColumn(db, "input_requests", "metadata_json")).toBe(true);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b45.4 input store and hub", () => {
  it("round-trips metadata and rejects non-choice answers while leaving pending", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b45-4-hub-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      db.prepare(
        "INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'WS')"
      ).run(root);
      db.prepare(
        `INSERT INTO automations (
          id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
        ) VALUES (
          'auto', 'ws', 'A', 1, 'enabled', '{"type":"manual"}', 'p', 'c.yaml', 'auto'
        )`
      ).run();
      db.prepare(
        `INSERT INTO runs (id, automation_id, workspace_id, status, trigger_kind, prompt)
         VALUES ('run', 'auto', 'ws', 'running', 'manual', 'p')`
      ).run();

      const store = new InputStore(db);
      let needsInput = 0;
      let answered = 0;
      const hub = new InputHub(store, {
        onNeedsInput: () => {
          needsInput += 1;
        },
        onAnswered: () => {
          answered += 1;
        },
      });

      const askPromise = hub.ask("run", "Approve the plan?", VALID_META);
      expect(needsInput).toBe(1);
      const pending = store.getPendingForRun("run");
      expect(pending?.metadata_json).toContain('"kind":"approval"');
      expect(rowToInputRequest(pending!).metadata?.recommendedChoiceId).toBe(
        "approve"
      );

      hub.submitAnswer("run", "Approve");
      expect(answered).toBe(1);
      await expect(askPromise).resolves.toBe("Approve");
      expect(store.getPendingForRun("run")).toBeUndefined();
      const answeredRow = store.listForRun("run")[0]!;
      expect(answeredRow.answer).toBe("Approve");
      expect(answeredRow.status).toBe("answered");
      expect(parseInputMetadataJson(answeredRow.metadata_json)?.kind).toBe(
        "approval"
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("degrades malformed historical metadata_json to absent", () => {
    expect(parseInputMetadataJson(null)).toBeNull();
    expect(parseInputMetadataJson("{not-json")).toBeNull();
    expect(parseInputMetadataJson(JSON.stringify({ kind: "" }))).toBeNull();
  });

  it("keeps free-form asks compatible", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b45-4-free-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      db.prepare(
        "INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'WS')"
      ).run(root);
      db.prepare(
        `INSERT INTO automations (
          id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
        ) VALUES (
          'auto', 'ws', 'A', 1, 'enabled', '{"type":"manual"}', 'p', 'c.yaml', 'auto'
        )`
      ).run();
      db.prepare(
        `INSERT INTO runs (id, automation_id, workspace_id, status, trigger_kind, prompt)
         VALUES ('run', 'auto', 'ws', 'running', 'manual', 'p')`
      ).run();

      const hub = new InputHub(new InputStore(db), {
        onNeedsInput: () => {},
        onAnswered: () => {},
      });
      const p = hub.ask("run", "Any thoughts?");
      hub.submitAnswer("run", "ship it");
      await expect(p).resolves.toBe("ship it");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b45.4 Guided plan-phase gate", () => {
  it("orders the gate after capacity split and before selection with exact choices", () => {
    const guided = renderPlanPhase("full", "before-implementation");
    const capacityIdx = guided.indexOf(
      "## 3. Capacity split (main coordinator only)"
    );
    const gateIdx = guided.indexOf(
      "## 4. Guided approval gate (main coordinator only)"
    );
    const selectionIdx = guided.indexOf("## 5. Selection / fan-out");
    expect(capacityIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(capacityIdx);
    expect(selectionIdx).toBeGreaterThan(gateIdx);

    expect(guided).toMatch(/kind`: `approval`/);
    expect(guided).toMatch(/`approve`, `revise`, and `abort`/);
    expect(guided).toMatch(/## Planning Approval/);
    expect(guided).toMatch(/`abort:`/);
    expect(guided).toMatch(/fresh\*\* structured/);
    expect(guided).toContain(
      "docs/roadmap/b45-configurable-implement-fully-planning"
    );
    expect(guided).toMatch(
      /rendered `approvalPolicy` is `before-implementation`[\s\S]*\(`before-implementation`\)/
    );
  });

  it("leaves approvalPolicy none and track prompts ungated", () => {
    for (const depth of ["jit", "full"] as const) {
      const text = renderPlanPhase(depth, "none");
      expect(text).toMatch(
        /When[\s\S]*`approvalPolicy` is `none`[\s\S]*no approval pause/
      );
      expect(text).toMatch(/Skip this section in track mode/);
      expect(text).toMatch(
        /Create or bypass the Guided approval gate from a track run/
      );
      expect(text).not.toMatch(/Must not[\s\S]*Enforce Guided approval/);
    }
  });

  it("does not add an approval-gate worker, conditional edge, or budget change", () => {
    expect(IMPLEMENT_FULLY_WORKERS).toHaveLength(8);
    expect(computeImplementFullyBudget(4)).toBe(6 * 4 + 1);
    const keys = IMPLEMENT_FULLY_WORKERS.map((w) => w.key);
    expect(keys).toContain("plan-phase");
    expect(keys).toContain("integrate-wave");
    expect(keys).toContain("final-gate");
    expect(keys).not.toContain("approval-gate");
  });
});

describe("b45.4 protocol and operator reference", () => {
  it("documents the Guided gate and drops carried-but-unenforced wording", () => {
    const protocol = readFileSync(PROTOCOL_PATH, "utf8");
    expect(protocol).toMatch(/Guided approval gate/i);
    expect(protocol).toMatch(/only the persisted choice id `approve`/i);
    expect(protocol).toMatch(/Files viewer/i);
    expect(protocol).not.toMatch(
      /approvalPolicy: before-implementation` is carried but not enforced/i
    );

    const reference = readFileSync(REFERENCE_PATH, "utf8");
    expect(reference).toMatch(/durable no-timeout Input Hub approval gate/i);
    expect(reference).toMatch(/only choice id `approve` advances/i);
    expect(reference).not.toMatch(/not enforced until the Guided gate phase/i);
  });
});
