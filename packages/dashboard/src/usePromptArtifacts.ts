import { useEffect, useState } from "react";
import { api, type WorkspaceArtifact } from "./api";

type PromptArtifactsState = {
  artifacts: WorkspaceArtifact[];
  loading: boolean;
  error: string | null;
};

const artifactCache = new Map<string, WorkspaceArtifact[]>();
const pendingRequests = new Map<string, Promise<WorkspaceArtifact[]>>();

function emptyState(): PromptArtifactsState {
  return { artifacts: [], loading: false, error: null };
}

export function usePromptArtifacts(
  workspaceId: string | undefined
): PromptArtifactsState {
  const [state, setState] = useState<PromptArtifactsState>(() => {
    if (!workspaceId) {
      return emptyState();
    }
    const cached = artifactCache.get(workspaceId);
    return cached
      ? { artifacts: cached, loading: false, error: null }
      : { artifacts: [], loading: true, error: null };
  });

  useEffect(() => {
    if (!workspaceId) {
      setState(emptyState());
      return;
    }

    const cached = artifactCache.get(workspaceId);
    if (cached) {
      setState({ artifacts: cached, loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState({ artifacts: [], loading: true, error: null });

    const request =
      pendingRequests.get(workspaceId) ??
      api.listWorkspaceArtifacts(workspaceId).finally(() => {
        pendingRequests.delete(workspaceId);
      });
    pendingRequests.set(workspaceId, request);

    request
      .then((artifacts) => {
        artifactCache.set(workspaceId, artifacts);
        if (!cancelled) {
          setState({ artifacts, loading: false, error: null });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            artifacts: [],
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  return state;
}
