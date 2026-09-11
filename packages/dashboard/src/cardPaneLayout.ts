import { useEffect, useState } from "react";

export type CardPaneKind = "log" | "prompt";

type PaneSpec = {
  storageKey: string;
  minPx: number;
  maxPx: number;
  defaultPx: number;
};

const PANE_SPECS: Record<CardPaneKind, PaneSpec> = {
  log: {
    storageKey: "lca.cardLogHeight",
    minPx: 120,
    maxPx: 720,
    /** Matches the previous fixed `h-72` (18rem). */
    defaultPx: 288,
  },
  prompt: {
    storageKey: "lca.cardPromptHeight",
    minPx: 80,
    maxPx: 480,
    /** Matches the previous body `max-h-40` (10rem). */
    defaultPx: 160,
  },
};

type HeightListener = (height: number) => void;

type PaneStore = {
  get: () => number;
  set: (px: number) => void;
  reset: () => void;
  subscribe: (listener: HeightListener) => () => void;
  clamp: (px: number) => number;
  minPx: number;
  maxPx: number;
  defaultPx: number;
};

function createPaneStore(spec: PaneSpec): PaneStore {
  const clamp = (px: number): number => {
    if (typeof px !== "number" || !Number.isFinite(px)) {
      return spec.defaultPx;
    }
    const rounded = Math.round(px);
    return Math.min(spec.maxPx, Math.max(spec.minPx, rounded));
  };

  const load = (): number => {
    try {
      const raw = localStorage.getItem(spec.storageKey);
      if (!raw) return spec.defaultPx;
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "number") {
        return clamp(parsed);
      }
    } catch {
      /* ignore malformed persisted height */
    }
    return spec.defaultPx;
  };

  const save = (px: number): void => {
    try {
      localStorage.setItem(spec.storageKey, JSON.stringify(clamp(px)));
    } catch {
      /* quota / private mode */
    }
  };

  let cached = load();
  const listeners = new Set<HeightListener>();

  return {
    minPx: spec.minPx,
    maxPx: spec.maxPx,
    defaultPx: spec.defaultPx,
    clamp,
    get: () => cached,
    set: (px: number) => {
      const next = clamp(px);
      if (next === cached) return;
      cached = next;
      save(next);
      for (const listener of listeners) {
        listener(next);
      }
    },
    reset: () => {
      const next = spec.defaultPx;
      if (next === cached) return;
      cached = next;
      save(next);
      for (const listener of listeners) {
        listener(next);
      }
    },
    subscribe: (listener: HeightListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const stores: Record<CardPaneKind, PaneStore> = {
  log: createPaneStore(PANE_SPECS.log),
  prompt: createPaneStore(PANE_SPECS.prompt),
};

export function getCardPaneStore(kind: CardPaneKind): PaneStore {
  return stores[kind];
}

/** Shared height for a card pane (log or prompt); persists across sessions. */
export function useCardPaneHeight(
  kind: CardPaneKind
): [number, (px: number) => void, PaneStore] {
  const store = stores[kind];
  const [height, setHeight] = useState(store.get);
  useEffect(() => store.subscribe(setHeight), [store]);
  return [height, store.set, store];
}
