import { HALT_DISCOVERY_INPUT_KIND, type InputRequest } from "@lca/shared";

/** Match `useRunStream` resumability: non-empty ids and non-`bc-` agent. */
export function isLocallyResumableAgentIdentity(
  agentId: string | null | undefined,
  sdkRunId: string | null | undefined
): boolean {
  return Boolean(agentId && sdkRunId && !agentId.startsWith("bc-"));
}

/** Pure eligibility for the advisory briefing promotion control. */
export function isHaltDiscoveryBriefingPromotionEligible(input: {
  request: InputRequest;
  canPromoteToChat?: boolean;
  onPromoteToChat?: () => void | Promise<void>;
}): boolean {
  return (
    input.request.status === "pending" &&
    input.request.metadata?.kind === HALT_DISCOVERY_INPUT_KIND &&
    Boolean(input.canPromoteToChat) &&
    typeof input.onPromoteToChat === "function"
  );
}
