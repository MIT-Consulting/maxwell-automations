import { useState, type JSX } from "react";
import type { InputRequest } from "@lca/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { isHaltDiscoveryBriefingPromotionEligible } from "./haltDiscoveryPromotionUi";
import {
  filesArtifactHref,
  handleFilesDeepLinkClick,
} from "./filesDeepLink";
import { MarkdownPreview } from "./MarkdownPreview";
import { isPlanApprovalShapedRequest } from "./planApprovalUi";

export {
  isHaltDiscoveryBriefingPromotionEligible,
  isLocallyResumableAgentIdentity,
} from "./haltDiscoveryPromotionUi";

/** Re-export for callers that historically imported the href builder from here. */
export { filesArtifactHref } from "./filesDeepLink";

export type InputRequestPanelProps = {
  request: InputRequest;
  workspaceId: string;
  onSubmit: (answer: string) => void | Promise<void>;
  className?: string;
  /**
   * Caller-declared local resumability (board agent identity / Logs `canContinue`).
   * Required with `onPromoteToChat` for the halt-discovery promotion control.
   */
  canPromoteToChat?: boolean;
  /** Invokes durable promote-to-chat; never used as an Input Hub answer. */
  onPromoteToChat?: () => void | Promise<void>;
};

/**
 * Durable operator input surface: Markdown question, artifact links into the
 * existing Files viewer, named choice buttons (or free-form fallback).
 */
export function InputRequestPanel({
  request,
  workspaceId,
  onSubmit,
  className,
  canPromoteToChat,
  onPromoteToChat,
}: InputRequestPanelProps): JSX.Element {
  const [value, setValue] = useState("");
  const [showOther, setShowOther] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);

  const choices = request.metadata?.choices;
  const artifacts = request.metadata?.artifacts;
  const recommended = request.metadata?.recommendedChoiceId;
  const structured = Boolean(choices && choices.length > 0);
  const planApprovalShaped = isPlanApprovalShapedRequest(request);
  const showPromote = isHaltDiscoveryBriefingPromotionEligible({
    request,
    canPromoteToChat,
    onPromoteToChat,
  });

  const submit = async (answer: string) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(answer);
      // Keep disabled on success; parent clears the pending surface.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  const promote = async () => {
    if (!onPromoteToChat || promoting || submitting) return;
    setPromoting(true);
    setPromoteError(null);
    try {
      await onPromoteToChat();
      // Keep disabled on success; parent navigates / clears the surface.
    } catch (err) {
      setPromoteError(err instanceof Error ? err.message : String(err));
      setPromoting(false);
    }
  };

  return (
    <div
      className={cn(
        "mt-2.5 rounded-md border border-border bg-card p-2",
        className
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-1.5 text-xs text-status-needs-input">
        <MarkdownPreview>{request.question}</MarkdownPreview>
      </div>

      {artifacts && artifacts.length > 0 && (
        <ul className="mb-2 flex flex-col gap-1 text-xs">
          {artifacts.map((artifact) => (
            <li key={`${artifact.label}:${artifact.path}`}>
              <a
                className="text-primary underline-offset-2 hover:underline"
                href={filesArtifactHref(workspaceId, artifact.path)}
                onClick={(e) => {
                  e.stopPropagation();
                  handleFilesDeepLinkClick(
                    e,
                    filesArtifactHref(workspaceId, artifact.path)
                  );
                }}
              >
                {artifact.label}
              </a>
              <span className="ml-1 text-muted-foreground">
                ({artifact.path})
              </span>
            </li>
          ))}
        </ul>
      )}

      {structured ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap gap-1.5">
            {choices!.map((choice) => {
              const isRecommended = recommended === choice.id;
              return (
                <Button
                  key={choice.id}
                  type="button"
                  size="sm"
                  variant={isRecommended ? "default" : "surface"}
                  disabled={submitting}
                  title={choice.description}
                  data-choice-id={choice.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    void submit(choice.id);
                  }}
                >
                  {choice.label}
                  {isRecommended ? (
                    <span className="ml-1 text-[10px] opacity-80">
                      (recommended)
                    </span>
                  ) : null}
                </Button>
              );
            })}
            {planApprovalShaped ? (
              <Button
                type="button"
                size="sm"
                variant={showOther ? "default" : "surface"}
                disabled={submitting}
                data-other-control="plan-approval"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowOther(true);
                }}
              >
                Other
              </Button>
            ) : null}
          </div>
          {planApprovalShaped && showOther ? (
            <form
              className="flex gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                const trimmed = value.trim();
                if (trimmed) {
                  void submit(trimmed);
                  setValue("");
                }
              }}
            >
              <Input
                autoFocus
                className="h-8 flex-1 text-xs"
                value={value}
                placeholder="Other response…"
                disabled={submitting}
                onChange={(e) => setValue(e.target.value)}
              />
              <Button
                type="submit"
                size="sm"
                variant="surface"
                disabled={submitting}
              >
                Send
              </Button>
            </form>
          ) : null}
        </div>
      ) : (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) {
              void submit(value.trim());
              setValue("");
            }
          }}
        >
          <Input
            autoFocus
            className="h-8 flex-1 text-xs"
            value={value}
            placeholder="Answer the agent…"
            disabled={submitting}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button type="submit" size="sm" variant="surface" disabled={submitting}>
            Send
          </Button>
        </form>
      )}

      {showPromote && (
        <div className="mt-2 flex flex-col gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={promoting || submitting}
            data-promote-to-chat="halt-discovery"
            onClick={(e) => {
              e.stopPropagation();
              void promote();
            }}
          >
            {promoting ? "Opening chat…" : "Continue diagnosis in chat"}
          </Button>
          {promoteError && (
            <div className="text-[11px] text-destructive">{promoteError}</div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-1.5 text-[11px] text-destructive">{error}</div>
      )}
    </div>
  );
}
