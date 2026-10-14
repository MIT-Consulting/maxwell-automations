import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  capabilitiesDocumentSchema,
  formatRunningLabel,
  type CapabilitiesDocument,
  type VersionIdentity,
} from "@lca/shared";
import { DaemonClient, DaemonError, resolveWorkspaceId } from "./client.js";
import { probeBundledSkillStatus } from "./skill-check.js";
import { loadCliIdentity } from "./version.js";

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export type ParsedCapabilitiesArgs =
  | { ok: true; json: boolean; workspaceQuery?: string }
  | { ok: false; message: string };

export function parseCapabilitiesArgs(
  argv: readonly string[]
): ParsedCapabilitiesArgs {
  let json = false;
  let workspaceQuery: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--workspace" || arg === "-w") {
      workspaceQuery = argv[++i];
      if (!workspaceQuery) {
        return {
          ok: false,
          message: "max capabilities --workspace requires an id|name|path.",
        };
      }
      continue;
    }
    return { ok: false, message: `Unknown option "${arg}" for max capabilities.` };
  }
  if (workspaceQuery) {
    return { ok: true, json, workspaceQuery };
  }
  return { ok: true, json };
}

export function enrichCapabilitiesDocument(
  base: CapabilitiesDocument,
  extras?: {
    cli?: VersionIdentity;
    skills?: NonNullable<CapabilitiesDocument["version"]["skills"]>;
  }
): CapabilitiesDocument {
  const cli = extras?.cli ?? loadCliIdentity().running;
  const skills = extras?.skills ?? probeBundledSkillStatus(repoRoot()).status;
  return {
    ...base,
    version: {
      ...base.version,
      cli,
      skills,
    },
  };
}

export function formatCapabilitiesHuman(doc: CapabilitiesDocument): string {
  const lines: string[] = [];
  const daemonLabel = formatRunningLabel(doc.version.daemon);
  const cliLabel = doc.version.cli
    ? formatRunningLabel(doc.version.cli)
    : "unknown";
  const skills = doc.version.skills ?? "unknown";

  lines.push("Max capability map");
  lines.push("");
  lines.push("Version");
  lines.push(`  Daemon: ${daemonLabel}`);
  lines.push(`  CLI:    ${cliLabel}`);
  if (doc.version.cli && doc.version.cli.version !== doc.version.daemon.version) {
    lines.push("  Note:   daemon and CLI builds differ — trust daemon surfaces.");
  }
  lines.push(`  Skills: ${skills}`);
  lines.push("");

  if (doc.workspace) {
    lines.push("Workspace");
    lines.push(`  ${doc.workspace.name} (${doc.workspace.id})`);
    lines.push(`  Readiness: ${doc.workspace.readiness.state}`);
    if (doc.workspace.pipeline.active) {
      const feature = doc.workspace.pipeline.featureId?.trim() || "pipeline";
      lines.push(
        `  Pipeline: active ${feature} (${doc.workspace.pipeline.outcome ?? "running"})`
      );
    } else {
      lines.push("  Pipeline: none active");
    }
    lines.push(
      `  Queue: queued=${doc.workspace.queue.counts.queued} running=${doc.workspace.queue.counts.running} blocked=${doc.workspace.queue.counts.blocked}`
    );
    lines.push("");
  }

  lines.push("Surfaces");
  for (const surface of doc.surfaces) {
    lines.push(`  ${surface.id}`);
    lines.push(`    Verb: ${surface.verb}`);
    lines.push(`    Best for: ${surface.bestFor}`);
    lines.push(`    Not for: ${surface.notFor}`);
    lines.push(`    Effect: ${surface.effect}`);
    if (surface.availability) {
      lines.push(
        `    Availability: ${surface.availability.status} — ${surface.availability.reason}`
      );
    }
    if (surface.needs.length > 0) {
      lines.push(`    Needs: ${surface.needs.join("; ")}`);
    }
  }
  lines.push("");

  lines.push("Profiles (role-model recipes)");
  for (const profile of doc.profiles) {
    const seats = Object.keys(profile.roleModels).sort().join(", ") || "(none)";
    lines.push(`  ${profile.id} — ${profile.label} [${seats}]`);
    if (profile.bestFor) {
      lines.push(`    Best for: ${profile.bestFor}`);
    }
  }
  lines.push("");

  lines.push("Planning profiles");
  for (const entry of doc.planning) {
    lines.push(`  ${entry.id} — ${entry.label}`);
    lines.push(`    ${entry.description}`);
    lines.push(
      `    Budget: ${entry.budgetFormula} (execute: ${entry.executeBudgetFormula})`
    );
  }
  lines.push("");

  lines.push("Statuses");
  for (const status of doc.statuses) {
    lines.push(
      `  ${status.domain}/${status.id}${status.terminal ? " (terminal)" : ""}: ${status.meaning} → ${status.verb}`
    );
  }
  lines.push("");

  lines.push("Playbooks");
  for (const playbook of doc.playbooks) {
    lines.push(`  ${playbook.id}: ${playbook.when}`);
    if (playbook.availability) {
      lines.push(
        `    Availability: ${playbook.availability.status} — ${playbook.availability.reason}`
      );
    }
    lines.push(`    Done: ${playbook.doneSignal}`);
    lines.push(`    Don't stop early: ${playbook.dontStopEarlyBecause}`);
    for (const step of playbook.steps) {
      lines.push(`    - ${step}`);
    }
  }
  lines.push("");

  lines.push("Anti-patterns");
  for (const item of doc.antiPatterns) {
    lines.push(`  - ${item}`);
  }
  lines.push("");

  lines.push("Pointers");
  for (const pointer of doc.pointers) {
    lines.push(`  ${pointer.id}: ${pointer.path} — ${pointer.note}`);
  }

  return lines.join("\n");
}

export async function cmdCapabilities(
  client: DaemonClient,
  argv: readonly string[]
): Promise<void> {
  const parsed = parseCapabilitiesArgs(argv);
  if (!parsed.ok) {
    throw new DaemonError(parsed.message);
  }

  const workspaceId = parsed.workspaceQuery
    ? await resolveWorkspaceId(client, parsed.workspaceQuery)
    : undefined;
  const base = await client.getCapabilities(workspaceId);
  const doc = enrichCapabilitiesDocument(base);
  capabilitiesDocumentSchema.parse(doc);

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(doc)}\n`);
    return;
  }

  console.log(formatCapabilitiesHuman(doc));
}
