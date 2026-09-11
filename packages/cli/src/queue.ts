import {
  IMPLEMENT_FULLY_PIPELINE_ID,
  type FeatureQueueEntry,
} from "@lca/shared";
import {
  DaemonClient,
  DaemonError,
  ProvisionConflictError,
} from "./client.js";
import {
  buildImplementFullyKickoff,
  parseImplementFullyArgs,
  type ImplementFullyArgs,
} from "./implement-fully.js";

const QUEUE_USAGE =
  "Usage: lca queue add --feature <bN> [options]\n" +
  "       lca queue add --idea <text> [options]\n" +
  "       lca queue list | rm <id> | clear";

function parseQueueAddArgs(args: string[]): {
  impl: ImplementFullyArgs;
  after: string[];
} {
  const after: string[] = [];
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--after") {
      const value = args[++i];
      if (!value) {
        throw new DaemonError("--after requires a value");
      }
      for (const part of value.split(",")) {
        const id = part.trim();
        if (id) {
          after.push(id);
        }
      }
      continue;
    }
    filtered.push(arg);
  }
  return { impl: parseImplementFullyArgs(filtered), after };
}

async function resolveQueueEntryId(
  client: DaemonClient,
  query: string
): Promise<string> {
  const entries = await client.listFeatureQueue();
  const matches = entries.filter((e) => e.id.startsWith(query));
  if (matches.length === 1) {
    return matches[0]!.id;
  }
  if (matches.length > 1) {
    throw new DaemonError(`Ambiguous queue entry prefix "${query}".`);
  }
  throw new DaemonError(`No queue entry matches "${query}".`);
}

function formatDependencies(after: string[]): string {
  return after.length === 0 ? "—" : after.join(",");
}

function formatShortRunId(runId: string | null): string {
  return runId ? runId.slice(0, 8) : "—";
}

function printQueueEntry(entry: FeatureQueueEntry): void {
  console.log(
    `  ${entry.state.padEnd(12)} ${entry.featureId.padEnd(8)} ` +
      `${formatDependencies(entry.after).padEnd(16)} ` +
      `${formatShortRunId(entry.runId).padEnd(8)} ` +
      `${entry.detail ?? ""}`
  );
}

async function cmdQueueAdd(
  client: DaemonClient,
  args: string[]
): Promise<void> {
  const { impl, after } = parseQueueAddArgs(args);
  const built = await buildImplementFullyKickoff(client, impl);

  if (built.architectJitWarning) {
    console.warn(built.architectJitWarning);
  }
  if (built.dryProvision.missingSkills.length > 0) {
    console.log(
      `Warning: missing skills (non-blocking): ${built.dryProvision.missingSkills.join(", ")}`
    );
  }

  try {
    await client.provisionPipelineWorkers(IMPLEMENT_FULLY_PIPELINE_ID, {
      workspaceId: built.workspace.id,
      dryRun: false,
      prune: impl.prune,
    });
  } catch (err) {
    if (err instanceof ProvisionConflictError) {
      const keys = err.response.plan.items
        .filter((i) => i.action === "conflict")
        .map((i) => i.key);
      throw new DaemonError(
        `Provisioning conflict for worker(s): ${keys.join(", ")}. ` +
          `Cannot enqueue until resolved.`
      );
    }
    throw err;
  }

  const entry = await client.enqueueFeature({
    workspaceId: built.workspace.id,
    featureId: built.resolved.featureId,
    after,
    kickoff: built.kickoff,
  });

  console.log(
    `Queued ${entry.featureId} at position ${entry.position}` +
      (entry.after.length > 0 ? ` after ${entry.after.join(", ")}` : "")
  );
  console.log(`  id:    ${entry.id}`);
  console.log(`  state: ${entry.state}`);
}

async function cmdQueueList(client: DaemonClient): Promise<void> {
  const entries = await client.listFeatureQueue();
  if (entries.length === 0) {
    console.log("(no queued features)");
    return;
  }
  console.log(
    `  ${"state".padEnd(12)} ${"feature".padEnd(8)} ` +
      `${"dependencies".padEnd(16)} ${"run".padEnd(8)} detail`
  );
  for (const entry of entries) {
    printQueueEntry(entry);
  }
}

async function cmdQueueRm(
  client: DaemonClient,
  query: string | undefined
): Promise<void> {
  if (!query) {
    throw new DaemonError(`Usage: lca queue rm <id>\n${QUEUE_USAGE}`);
  }
  const id = await resolveQueueEntryId(client, query);
  const entry = await client.cancelFeatureQueueEntry(id);
  console.log(`Cancelled ${entry.featureId} (${entry.id.slice(0, 8)})`);
}

async function cmdQueueClear(client: DaemonClient): Promise<void> {
  const entries = await client.listFeatureQueue();
  const cancellable = entries.filter(
    (e) => e.state === "queued" || e.state === "blocked"
  );
  let count = 0;
  for (const entry of cancellable) {
    await client.cancelFeatureQueueEntry(entry.id);
    count += 1;
  }
  console.log(`Cancelled ${count} waiting entr${count === 1 ? "y" : "ies"}.`);
}

export async function cmdQueue(
  client: DaemonClient,
  args: string[]
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub ?? "list") {
    case "list":
      await cmdQueueList(client);
      return;
    case "add":
      await cmdQueueAdd(client, rest);
      return;
    case "rm":
      await cmdQueueRm(client, rest[0]);
      return;
    case "clear":
      await cmdQueueClear(client);
      return;
    default:
      throw new DaemonError(
        `Unknown queue subcommand "${sub}". Try: add | list | rm | clear`
      );
  }
}
