import { ChevronDown, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { FilesDocLink } from "./FilesDocLink";
import {
  collectGroupPhaseDocLinksInDir,
  indexPathInDir,
  prdPathInDir,
} from "./pipelineDocLinks";
import { useFeatureDocsListing } from "./useFeatureDocsListing";
import { useFeatureRoadmapDir } from "./useFeatureRoadmapDir";

type DocMenuItem = {
  key: string;
  label: string;
  path: string;
};

/**
 * Single entry point for a pipeline's source docs (feature index, PRD, and
 * per-phase files), replacing an unbounded inline "Index · PRD · phase1 ·
 * phase2 · …" chain in the group header. Resolves the feature's roadmap dir
 * (live vs. `/roadmap-tidy`-archived under `docs/roadmap/done/`) so links
 * for completed pipelines keep working after archiving. Docs we know aren't
 * written yet show as disabled with a "not created yet" hint instead of
 * linking to a 404.
 */
export function PipelineDocsMenu({
  workspaceId,
  featureSlug,
  runs,
}: {
  workspaceId: string;
  featureSlug: string;
  runs: ReadonlyArray<{
    pipelineTrack?: { phaseRef: string; phaseFile: string } | null;
    title?: string | null;
  }>;
}) {
  const dir = useFeatureRoadmapDir(workspaceId, featureSlug);
  const { names } = useFeatureDocsListing(workspaceId, dir);
  const phaseDocs = collectGroupPhaseDocLinksInDir(dir, runs);

  const items: DocMenuItem[] = [
    { key: "index", label: "Index", path: indexPathInDir(dir) },
    { key: "prd", label: "PRD", path: prdPathInDir(dir) },
    ...phaseDocs.map((p) => ({ key: p.path, label: p.phaseRef, path: p.path })),
  ];

  // `null` = can't verify (nested path, or listing failed/loading) — never
  // dim a link just because we're unsure.
  const existsFor = (path: string): boolean | null => {
    if (!names) return null;
    const slash = path.lastIndexOf("/");
    if (path.slice(0, slash) !== dir) return null;
    return names.has(path.slice(slash + 1));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-5 gap-1 rounded px-1.5 py-0 text-[11px] font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Source docs for this pipeline"
          onClick={(e) => e.stopPropagation()}
        >
          <FileText className="size-3" aria-hidden="true" />
          Docs
          <span className="text-[10px] text-muted-foreground/80">
            {items.length}
          </span>
          <ChevronDown className="size-2.5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-72"
        onClick={(e) => e.stopPropagation()}
      >
        <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">
          Source docs
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.map((item) => {
          const exists = existsFor(item.path);
          const missing = exists === false;

          const rowContent = (
            <>
              <span className="flex w-full items-center gap-1.5">
                <FileText
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="truncate">{item.label}</span>
                {missing && (
                  <span className="ml-auto shrink-0 text-[10px] italic text-muted-foreground/70">
                    not created yet
                  </span>
                )}
              </span>
              <span className="w-full truncate pl-5 font-mono text-[10px] text-muted-foreground">
                {item.path}
              </span>
            </>
          );

          if (missing) {
            return (
              <DropdownMenuItem
                key={item.key}
                disabled
                title="Not created yet"
                className="flex-col items-start gap-0.5 opacity-60"
              >
                {rowContent}
              </DropdownMenuItem>
            );
          }

          return (
            <DropdownMenuItem key={item.key} asChild className="flex-col items-start gap-0.5">
              <FilesDocLink
                workspaceId={workspaceId}
                path={item.path}
                className={cn("no-underline hover:no-underline")}
                title={item.path}
              >
                {rowContent}
              </FilesDocLink>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Feature-title link used in the pipeline group header; same archived-dir
 *  resolution as the docs menu so it doesn't 404 after `/roadmap-tidy`. */
export function FeatureLabelLink({
  workspaceId,
  featureSlug,
  label,
}: {
  workspaceId: string;
  featureSlug: string;
  label: string;
}) {
  const dir = useFeatureRoadmapDir(workspaceId, featureSlug);
  const path = indexPathInDir(dir);
  return (
    <FilesDocLink
      workspaceId={workspaceId}
      path={path}
      className="font-semibold text-foreground"
      title={`Open ${path}`}
    >
      {label}
    </FilesDocLink>
  );
}
