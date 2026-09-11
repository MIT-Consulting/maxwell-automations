import type { WorkspaceArtifact } from "./api";
import { cn } from "@/lib/utils";

type PromptArtifactSuggestionsProps = {
  open: boolean;
  artifacts: WorkspaceArtifact[];
  loading: boolean;
  error: string | null;
  highlightedIndex: number;
  onHighlight: (index: number) => void;
  onSelect: (artifact: WorkspaceArtifact) => void;
  kind: WorkspaceArtifact["kind"];
  id?: string;
  className?: string;
};

export function PromptArtifactSuggestions({
  open,
  artifacts,
  loading,
  error,
  highlightedIndex,
  onHighlight,
  onSelect,
  kind,
  id,
  className,
}: PromptArtifactSuggestionsProps) {
  if (!open) {
    return null;
  }

  return (
    <div
      id={id}
      className={cn(
        "absolute left-0 right-0 top-[calc(100%+6px)] z-20 max-h-[220px] overflow-y-auto rounded-md border border-border bg-muted p-1 shadow-[0_12px_32px_rgba(0,0,0,0.35)]",
        className
      )}
      role="listbox"
      aria-label={`${kind} suggestions`}
    >
      {loading ? (
        <div className="px-2.5 py-2 text-xs text-muted-foreground">
          Loading {kind}s…
        </div>
      ) : error ? (
        <div className="px-2.5 py-2 text-xs text-destructive">
          Could not load references: {error}
        </div>
      ) : artifacts.length === 0 ? (
        <div className="px-2.5 py-2 text-xs text-muted-foreground">
          No matching {kind}s
        </div>
      ) : (
        artifacts.map((artifact, index) => (
          <button
            key={`${artifact.kind}:${artifact.source}:${artifact.path}`}
            type="button"
            role="option"
            aria-selected={index === highlightedIndex}
            className={cn(
              "flex w-full flex-col gap-0.5 rounded-sm border border-transparent px-2.5 py-2 text-left",
              index === highlightedIndex
                ? "border-ring bg-accent"
                : "hover:border-ring hover:bg-accent"
            )}
            onMouseEnter={() => onHighlight(index)}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(artifact);
            }}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="font-mono text-[13px] font-semibold">
                {artifact.name}
              </span>
              <span className="inline-flex shrink-0 gap-1">
                <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase leading-none text-muted-foreground">
                  {artifact.kind}
                </span>
                <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase leading-none text-muted-foreground">
                  {artifact.source}
                </span>
              </span>
            </span>
            {artifact.description && (
              <span
                className="truncate text-xs text-muted-foreground"
                title={artifact.description}
              >
                {artifact.description}
              </span>
            )}
          </button>
        ))
      )}
    </div>
  );
}
