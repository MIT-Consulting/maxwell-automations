import {
  IMPLEMENT_FULLY_PIPELINE_ID,
  newestRowForFeature,
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
  "Usage: lca queue add --feature <feature-id> [options]\n" +
  "       lca queue add --idea <text> [options]\n" +
  "       lca queue list [--json | -v] | rm <id> | move <id> [--before|--after <id>|--top] | clear";

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

function formatOriginTag(entry: FeatureQueueEntry): string {
  return entry.origin === "direct" ? "[direct] " : "";
}

function printQueueEntry(entry: FeatureQueueEntry): void {
  let detail = `${formatOriginTag(entry)}${entry.detail ?? ""}`.trim();
  const thenKey = entry.entryDetail.then;
  if (thenKey) {
    detail = detail.length > 0 ? `${detail} then ${thenKey}` : `then ${thenKey}`;
  }
  console.log(
    `  ${entry.state.padEnd(12)} ${entry.featureId.padEnd(8)} ` +
      `${formatDependencies(entry.after).padEnd(16)} ` +
      `${formatShortRunId(entry.runId).padEnd(8)} ` +
      detail
  );
}

function formatRecipeLine(detail: FeatureQueueEntry["entryDetail"]): string {
  if (detail.roleModelProfileId) {
    return `recipe: ${detail.roleModelProfileId}`;
  }
  if (detail.roleModels && detail.roleModels.length > 0) {
    return `recipe: ${detail.roleModels
      .map(({ role, modelId }) => `${role}=${modelId}`)
      .join(", ")}`;
  }
  return "recipe: (none)";
}

function formatAfterLines(
  entry: FeatureQueueEntry,
  entries: readonly FeatureQueueEntry[]
): string[] {
  if (entry.after.length === 0) {
    return [];
  }
  return entry.after.map((depId) => {
    const newest = newestRowForFeature(entries, depId);
    const state = newest?.state ?? "missing";
    return `after ${depId} (${state})`;
  });
}

function printQueueEntryVerbose(
  entry: FeatureQueueEntry,
  entries: readonly FeatureQueueEntry[]
): void {
  printQueueEntry(entry);
  const detail = entry.entryDetail;
  const lines = [
    `  doc: ${detail.featureDocPath ?? "(none)"}`,
    `  ${formatRecipeLine(detail)}`,
    `  planningDepth: ${detail.planningDepth ?? "(none)"}`,
    `  approvalPolicy: ${detail.approvalPolicy ?? "(none)"}`,
    `  researchApprovalPolicy: ${detail.researchApprovalPolicy ?? "(none)"}`,
    `  loopMode: ${detail.loopMode ?? "(none)"}`,
    ...(detail.then ? [`  then: ${detail.then}`] : []),
    ...formatAfterLines(entry, entries).map((line) => `  ${line}`),
    `  position: ${entry.position}`,
    `  createdAt: ${entry.createdAt}`,
  ];
  for (const line of lines) {
    console.log(line);
  }
}

function parseQueueListArgs(args: string[]): {
  json: boolean;
  verbose: boolean;
} {
  let json = false;
  let verbose = false;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "-v") {
      verbose = true;
      continue;
    }
    throw new DaemonError(`Unknown queue list option "${arg}".\n${QUEUE_USAGE}`);
  }
  return { json, verbose };
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

  if (impl.dryRun) {
    console.log("Dry run — nothing written.");
    console.log(built.summaryLines.join("\n"));
    console.log("Queue payload:");
    console.log(
      JSON.stringify(
        {
          workspaceId: built.workspace.id,
          featureId: built.resolved.featureId,
          after,
          kickoff: built.kickoff,
        },
        null,
        2
      )
    );
    return;
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

async function cmdQueueList(
  client: DaemonClient,
  args: string[] = []
): Promise<void> {
  const { json, verbose } = parseQueueListArgs(args);
  const entries = await client.listFeatureQueue();
  if (json) {
    console.log(JSON.stringify({ entries }, null, 2));
    return;
  }
  if (entries.length === 0) {
    console.log("(no queued features)");
    return;
  }
  console.log(
    `  ${"state".padEnd(12)} ${"feature".padEnd(8)} ` +
      `${"dependencies".padEnd(16)} ${"run".padEnd(8)} detail`
  );
  for (const entry of entries) {
    if (verbose) {
      printQueueEntryVerbose(entry, entries);
      console.log("");
    } else {
      printQueueEntry(entry);
    }
  }
}

function parseQueueMoveArgs(args: string[]): {
  query: string;
  body: { before: string } | { after: string } | { top: true };
} {
  if (args.length === 0) {
    throw new DaemonError(`Usage: lca queue move <id> [--before|--after <id>|--top]\n${QUEUE_USAGE}`);
  }
  const query = args[0]!;
  let before: string | undefined;
  let after: string | undefined;
  let top = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--before") {
      const value = args[++i];
      if (!value) {
        throw new DaemonError("--before requires a value");
      }
      before = value;
      continue;
    }
    if (arg === "--after") {
      const value = args[++i];
      if (!value) {
        throw new DaemonError("--after requires a value");
      }
      after = value;
      continue;
    }
    if (arg === "--top") {
      top = true;
      continue;
    }
    throw new DaemonError(`Unknown queue move option "${arg}".\n${QUEUE_USAGE}`);
  }
  const flagCount = [before != null, after != null, top].filter(Boolean).length;
  if (flagCount === 0) {
    throw new DaemonError(
      `queue move requires exactly one of --before, --after, or --top.\n${QUEUE_USAGE}`
    );
  }
  if (flagCount > 1) {
    throw new DaemonError(
      `queue move accepts only one of --before, --after, or --top.\n${QUEUE_USAGE}`
    );
  }
  if (before != null) {
    return { query, body: { before } };
  }
  if (after != null) {
    return { query, body: { after } };
  }
  return { query, body: { top: true } };
}

async function cmdQueueMove(
  client: DaemonClient,
  args: string[]
): Promise<void> {
  const { query, body } = parseQueueMoveArgs(args);
  const subjectId = await resolveQueueEntryId(client, query);
  let moveBody = body;
  if ("before" in body) {
    moveBody = { before: await resolveQueueEntryId(client, body.before) };
  } else if ("after" in body) {
    moveBody = { after: await resolveQueueEntryId(client, body.after) };
  }
  const entry = await client.moveFeatureQueueEntry(subjectId, moveBody);
  console.log(`Moved ${entry.featureId} to position ${entry.position}`);
  console.log(`  id:    ${entry.id}`);
  console.log(`  state: ${entry.state}`);
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
      await cmdQueueList(client, rest);
      return;
    case "add":
      await cmdQueueAdd(client, rest);
      return;
    case "rm":
      await cmdQueueRm(client, rest[0]);
      return;
    case "move":
      await cmdQueueMove(client, rest);
      return;
    case "clear":
      await cmdQueueClear(client);
      return;
    default:
      throw new DaemonError(
        `Unknown queue subcommand "${sub}". Try: add | list | rm | move | clear`
      );
  }
}
