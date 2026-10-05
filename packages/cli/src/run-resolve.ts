import { DaemonClient, DaemonError } from "./client.js";

/** Resolve a run id query (exact id or unique prefix). */
export async function resolveRunId(
  client: DaemonClient,
  query: string
): Promise<string> {
  try {
    const snap = await client.getRun(query);
    return snap.run.id;
  } catch {
    /* fall through to prefix match */
  }
  const runs = await client.listRuns();
  const matches = runs.filter((r) => r.id.startsWith(query));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    throw new DaemonError(`Ambiguous run id prefix "${query}".`);
  }
  throw new DaemonError(`No run matches "${query}".`);
}
