/** Optional external orchestrator label — not an auth principal. */
export const ACTOR_ID_MAX_LENGTH = 64;
export const ACTOR_ID_HEADER = "X-LCA-Actor";

export type ActorIdParseResult =
  | { ok: true; actorId: string | undefined }
  | { ok: false; error: string };

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

/** Trim once; reject control chars and over-limit values. */
export function sanitizeActorId(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (CONTROL_CHAR_RE.test(trimmed)) return undefined;
  if (trimmed.length > ACTOR_ID_MAX_LENGTH) return undefined;
  return trimmed;
}

export function parseActorIdFromRequest(args: {
  header?: string | null;
  bodyActorId?: unknown;
}): ActorIdParseResult {
  const headerPresent =
    args.header != null && String(args.header).trim().length > 0;
  const bodyPresent =
    args.bodyActorId != null &&
    typeof args.bodyActorId === "string" &&
    args.bodyActorId.trim().length > 0;

  const fromHeader = headerPresent ? sanitizeActorId(args.header) : undefined;
  const fromBody = bodyPresent ? sanitizeActorId(args.bodyActorId) : undefined;

  if (headerPresent && fromHeader === undefined) {
    return { ok: false, error: "Invalid X-LCA-Actor header" };
  }
  if (bodyPresent && fromBody === undefined) {
    return { ok: false, error: "Invalid actorId in request body" };
  }
  if (
    fromHeader !== undefined &&
    fromBody !== undefined &&
    fromHeader !== fromBody
  ) {
    return {
      ok: false,
      error: "X-LCA-Actor header and body actorId disagree",
    };
  }
  return { ok: true, actorId: fromHeader ?? fromBody };
}

export function withActorIdPayload(
  payload: Record<string, unknown>,
  actorId?: string
): Record<string, unknown> {
  if (!actorId) return payload;
  return { ...payload, actorId };
}
