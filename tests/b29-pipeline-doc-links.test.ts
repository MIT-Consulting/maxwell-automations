import { describe, expect, it } from "vitest";
import {
  collectGroupPhaseDocLinksInDir,
  featureRoadmapDir,
  indexPathInDir,
  pipelineRunDocPathInDir,
  prdPathInDir,
  resolvePhaseDocPathInDir,
} from "../packages/dashboard/src/pipelineDocLinks.ts";

describe("pipeline kanban doc links", () => {
  it("derives feature index and PRD under docs/roadmap/<slug>", () => {
    const dir = featureRoadmapDir("b48-ntfy-phone-notify");
    expect(indexPathInDir(dir)).toBe(
      "docs/roadmap/b48-ntfy-phone-notify/00-index.md"
    );
    expect(prdPathInDir(dir)).toBe(
      "docs/roadmap/b48-ntfy-phone-notify/prd.md"
    );
  });

  it("resolves bare phase files under the feature dir", () => {
    expect(
      resolvePhaseDocPathInDir(
        featureRoadmapDir("b48-ntfy-phone-notify"),
        "02-ntfy-transport-sink.md"
      )
    ).toBe("docs/roadmap/b48-ntfy-phone-notify/02-ntfy-transport-sink.md");
  });

  it("keeps workspace-relative docs/ phase paths", () => {
    expect(
      resolvePhaseDocPathInDir(
        featureRoadmapDir("b36-implement-fully"),
        "docs/roadmap/b36/06a.md"
      )
    ).toBe("docs/roadmap/b36/06a.md");
  });

  it("collects unique phase docs from group runs in order", () => {
    const links = collectGroupPhaseDocLinksInDir(
      featureRoadmapDir("b48-ntfy-phone-notify"),
      [
        {
          pipelineTrack: {
            phaseRef: "2",
            phaseFile: "02-ntfy-transport-sink.md",
          },
        },
        {
          pipelineTrack: {
            phaseRef: "2",
            phaseFile: "02-ntfy-transport-sink.md",
          },
        },
        {
          pipelineTrack: {
            phaseRef: "3",
            phaseFile:
              "docs/roadmap/b48-ntfy-phone-notify/03-existing-event-integration.md",
          },
        },
        { pipelineTrack: null },
      ]
    );
    expect(links).toEqual([
      {
        phaseRef: "2",
        path: "docs/roadmap/b48-ntfy-phone-notify/02-ntfy-transport-sink.md",
      },
      {
        phaseRef: "3",
        path: "docs/roadmap/b48-ntfy-phone-notify/03-existing-event-integration.md",
      },
    ]);
  });

  it("prefers phase doc for a run chip, else feature index", () => {
    const dir = featureRoadmapDir("b48-ntfy-phone-notify");
    expect(pipelineRunDocPathInDir(dir, "02-ntfy-transport-sink.md")).toBe(
      "docs/roadmap/b48-ntfy-phone-notify/02-ntfy-transport-sink.md"
    );
    expect(pipelineRunDocPathInDir(dir, null)).toBe(
      "docs/roadmap/b48-ntfy-phone-notify/00-index.md"
    );
    expect(pipelineRunDocPathInDir(null, "02.md")).toBeNull();
  });
});
