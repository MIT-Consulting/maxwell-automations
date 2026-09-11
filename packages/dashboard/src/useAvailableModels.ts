import { useSyncExternalStore } from "react";
import { DEFAULT_AUTOMATION_MODEL, type ModelInfo } from "@lca/shared";
import { api } from "./api";

type CatalogSnapshot = {
  models: ModelInfo[];
  defaultModel: string;
  loading: boolean;
  failed: boolean;
  warning: string | null;
};

const idleSnapshot: CatalogSnapshot = {
  models: [],
  defaultModel: DEFAULT_AUTOMATION_MODEL,
  loading: true,
  failed: false,
  warning: null,
};

let snapshot: CatalogSnapshot = idleSnapshot;
let successCached = false;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function ensureFetch(): void {
  if (successCached || inFlight) return;

  snapshot = {
    models: [],
    defaultModel: DEFAULT_AUTOMATION_MODEL,
    loading: true,
    failed: false,
    warning: null,
  };

  inFlight = api
    .listModels()
    .then((data) => {
      snapshot = {
        models: data.models,
        defaultModel: data.defaultModel,
        loading: false,
        failed: Boolean(data.warning) || data.models.length === 0,
        warning: data.warning ?? null,
      };
      successCached = true;
    })
    .catch(() => {
      snapshot = {
        models: [],
        defaultModel: DEFAULT_AUTOMATION_MODEL,
        loading: false,
        failed: true,
        warning: null,
      };
      // Failure is not cached — a later mount may retry.
    })
    .finally(() => {
      inFlight = null;
      emit();
    });
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  const before = snapshot;
  ensureFetch();
  if (snapshot !== before) {
    onStoreChange();
  }
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): CatalogSnapshot {
  return snapshot;
}

export function useAvailableModels(): {
  models: ModelInfo[];
  defaultModel: string;
  loading: boolean;
  failed: boolean;
  warning: string | null;
} {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
