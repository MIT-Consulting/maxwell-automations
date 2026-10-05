import {
  compareRoadmapFindings,
  type RoadmapFinding,
  type RoadmapReadinessReport,
  type RoadmapReadinessWorkspaceSummary,
} from "@lca/shared";
import type { ResolveKickoffInputKind } from "./pipelineKickoff";

export function formatReadinessFindingLine(finding: RoadmapFinding): string {
  // Idea-only refusals keep the exact b77 marker strings (same as resolve).
  if (finding.impact === "idea-only") return finding.message;
  const fix = finding.fix.trim();
  return fix.length > 0 ? `${finding.message} ${fix}` : finding.message;
}

export function describeReadinessSummaryLabel(
  summary: RoadmapReadinessWorkspaceSummary
): string {
  const blockers =
    summary.counts["blocks-all"] + summary.counts["blocks-some"];
  if (summary.state === "ready") {
    return blockers > 0 ? "Roadmap ready with blockers" : "Roadmap ready";
  }
  if (blockers > 0) {
    return `Roadmap ${summary.state}, ${blockers} blocker(s)`;
  }
  return `Roadmap ${summary.state}`;
}

export function formatPostRegisterReadinessLine(
  summary: RoadmapReadinessWorkspaceSummary
): string {
  const label = describeReadinessSummaryLabel(summary);
  return `Roadmap readiness: ${label}.`;
}

export type KickoffReadinessPresentation = {
  blockers: string[];
  notes: string[];
};

export function describeKickoffReadinessBlockers(args: {
  report: RoadmapReadinessReport;
  roadmapIndexPresent: boolean;
  inputKind: ResolveKickoffInputKind;
  featureId: string;
}): KickoffReadinessPresentation {
  const blockers: string[] = [];
  const notes: string[] = [];

  if (!args.roadmapIndexPresent) {
    blockers.push(
      "Missing roadmap index (docs/roadmap/00-index.md). Create docs/roadmap/00-index.md or run max roadmap init."
    );
  }

  const findings = [...args.report.findings].sort(compareRoadmapFindings);
  for (const finding of findings) {
    const line = formatReadinessFindingLine(finding);
    if (finding.impact === "blocks-all") {
      blockers.push(line);
      continue;
    }
    if (finding.impact === "info") {
      notes.push(line);
      continue;
    }
    if (finding.impact === "idea-only") {
      if (args.inputKind === "idea") {
        blockers.push(line);
      } else {
        notes.push(line);
      }
      continue;
    }
    if (finding.impact === "blocks-some") {
      const id = args.featureId.trim();
      if (args.inputKind === "feature-id" && id && finding.featureIds?.includes(id)) {
        blockers.push(line);
      }
    }
  }

  return { blockers, notes };
}
