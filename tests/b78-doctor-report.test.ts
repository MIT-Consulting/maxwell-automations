import { describe, expect, it } from "vitest";
import { scanLeaks } from "../scripts/export-public.mjs";
import {
  aliasWorkspaceIds,
  buildDoctorSupportReport,
  formatDoctorSupportReportText,
  type DoctorSupportReportClient,
} from "../packages/cli/src/doctor.ts";
import type {
  Automation,
  DaemonStatus,
  FeatureQueueEntry,
  RoadmapReadinessReport,
  RoadmapReadinessSummariesResponse,
  Run,
  Workspace,
} from "@lca/shared";

const LEAKY_PATH = "C:\\Users\\RealOperator\\projects\\demo";
const LEAKY_WORKSPACE_ID = Buffer.from(LEAKY_PATH, "utf8").toString("base64url");

const liveStatus: DaemonStatus = {
  ok: true,
  version: "0.0.0-test",
  pid: 1,
  port: 3747,
  host: "127.0.0.1",
  bindAddresses: ["127.0.0.1", "100.64.0.2"],
  allowedIps: ["100.64.0.2"],
  remoteAuth: true,
  mode: "prod",
  startedAt: new Date().toISOString(),
  uptimeMs: 60_000,
};

function mockClient(): DoctorSupportReportClient {
  const workspaces: Workspace[] = [
    {
      id: LEAKY_WORKSPACE_ID,
      name: "demo",
      path: LEAKY_PATH,
      createdAt: new Date().toISOString(),
    },
  ];
  const summaries: RoadmapReadinessSummariesResponse = {
    workspaces: [
      {
        workspaceId: LEAKY_WORKSPACE_ID,
        state: "adoptable",
        counts: {
          "blocks-all": 1,
          "blocks-some": 0,
          "idea-only": 0,
          info: 0,
        },
      },
    ],
  };
  const fullReport: RoadmapReadinessReport = {
    state: "adoptable",
    findings: [
      {
        code: "not-git-repo",
        impact: "blocks-all",
        message: "Workspace is not a git repository",
        fix: "Run git init in the workspace root.",
        fixable_by: "user",
        path: "docs/roadmap/00-index.md",
      },
    ],
    features: [],
    candidates: [
      {
        path: "C:\\Users\\RealOperator\\ROADMAP.md",
        estimatedItems: 40,
      },
    ],
  };

  return {
    listWorkspaces: async () => workspaces,
    getRoadmapReadinessSummaries: async () => summaries,
    getWorkspaceRoadmapReadiness: async () => fullReport,
    listRuns: async () => [] as Run[],
    listFeatureQueue: async () => [] as FeatureQueueEntry[],
    listAutomations: async () => [] as Automation[],
  };
}

describe("b78 doctor --report", () => {
  it("aliases workspace ids and allowlists fields without leaking identity", async () => {
    const aliases = aliasWorkspaceIds([LEAKY_WORKSPACE_ID, "ws-other"]);
    expect(aliases.get(LEAKY_WORKSPACE_ID)).toMatch(/^ws\d+$/);
    expect(aliases.get("ws-other")).toMatch(/^ws\d+$/);
    expect(aliases.get(LEAKY_WORKSPACE_ID)).not.toBe(aliases.get("ws-other"));

    const report = await buildDoctorSupportReport({
      cliVersion: "test-cli",
      environment: {
        cliNode: process.versions.node,
        requirement: ">=22.13",
        requirementSource: "package.json",
        npmVersion: "10.0.0",
        skillStatus: "in-sync",
      },
      live: liveStatus,
      client: mockClient(),
    });

    expect(report.roadmaps[0]?.alias).toBe("ws1");
    expect(report.roadmaps[0]?.findings[0]?.code).toBe("not-git-repo");
    expect(report.roadmaps[0]?.findings[0]?.path).toBe(
      "docs/roadmap/00-index.md"
    );
    expect(report.daemon.mode).toBe("prod");
    expect(report.daemon.remoteAuth).toBe(true);

    const encoded = JSON.stringify(report);
    expect(encoded).not.toContain(LEAKY_WORKSPACE_ID);
    expect(encoded).not.toContain(LEAKY_PATH);
    expect(encoded).not.toContain("RealOperator");
    expect(encoded).not.toContain("127.0.0.1");
    expect(encoded).not.toContain("100.64.0.2");
    expect(encoded).not.toContain("bindAddresses");
    expect(encoded).not.toContain("allowedIps");
    expect(encoded).not.toContain("Workspace is not a git repository");
    expect(encoded).not.toContain("ROADMAP.md");
    expect(report).not.toHaveProperty("host");

    const text = formatDoctorSupportReportText(report);
    const hits = scanLeaks("doctor-report.json", text);
    expect(hits).toEqual([]);
  });

  it("embeds deliberate leak bait that scanLeaks still catches when unredacted", () => {
    const uuid = ["d3f79bee", "51e3", "4804", "9cf1", "e5fec631d477"].join("-");
    const tailnet = ["100", "77", "138", "106"].join(".");
    const hostname = ["lair", "node"].join("-");
    const email = ["the.david", "jmiller@"].join("");
    const bait = [
      "path: C:\\Users\\RealOperator\\secret",
      `email: ${email}example.com`,
      `host: ${tailnet}`,
      `hostname: ${hostname}`,
      `see [chat](${uuid})`,
    ].join("\n");
    const ids = scanLeaks("bait.txt", bait).map((h) => h.id).sort();
    expect(ids).toEqual(
      [
        "lab-hostname",
        "operator-email",
        "operator-tailnet",
        "transcript-uuid-link",
        "windows-user-path",
      ].sort()
    );
  });
});
