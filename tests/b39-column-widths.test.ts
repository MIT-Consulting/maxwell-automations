import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildGridTemplateColumns,
  clampColumnWidth,
  COLUMN_KEYS,
  COLUMN_WIDTHS_KEY,
  loadColumnWidths,
  OPEN_COLUMN_DEFAULT_WIDTH_PX,
  OPEN_COLUMN_MAX_WIDTH_PX,
  OPEN_COLUMN_MIN_WIDTH_PX,
  type ColumnKey,
  type ColumnMeta,
} from "../packages/dashboard/src/columnLayout.ts";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

function allMeta(collapsed: Partial<Record<ColumnKey, boolean>> = {}): Record<
  ColumnKey,
  ColumnMeta
> {
  const meta = {} as Record<ColumnKey, ColumnMeta>;
  for (const key of COLUMN_KEYS) {
    meta[key] = { count: 1, collapsed: collapsed[key] ?? false };
  }
  return meta;
}

describe("b39 column widths", () => {
  const originalLocalStorage = globalThis.localStorage;

  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: memoryStorage(),
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
    });
  });

  it("clamps widths to min/max and rounds", () => {
    expect(clampColumnWidth(100)).toBe(OPEN_COLUMN_MIN_WIDTH_PX);
    expect(clampColumnWidth(9999)).toBe(OPEN_COLUMN_MAX_WIDTH_PX);
    expect(clampColumnWidth(321.6)).toBe(322);
    expect(clampColumnWidth(Number.NaN)).toBe(OPEN_COLUMN_DEFAULT_WIDTH_PX);
  });

  it("loads defaults when storage is empty", () => {
    const widths = loadColumnWidths();
    for (const key of COLUMN_KEYS) {
      expect(widths[key]).toBe(OPEN_COLUMN_DEFAULT_WIDTH_PX);
    }
  });

  it("overlays partial valid widths and clamps stored values", () => {
    localStorage.setItem(
      COLUMN_WIDTHS_KEY,
      JSON.stringify({
        running: 500,
        failed: 100,
        backlog: "nope",
        enabled: null,
      })
    );
    const widths = loadColumnWidths();
    expect(widths.running).toBe(500);
    expect(widths.failed).toBe(OPEN_COLUMN_MIN_WIDTH_PX);
    expect(widths.backlog).toBe(OPEN_COLUMN_DEFAULT_WIDTH_PX);
    expect(widths.enabled).toBe(OPEN_COLUMN_DEFAULT_WIDTH_PX);
  });

  it("returns defaults for malformed JSON", () => {
    localStorage.setItem(COLUMN_WIDTHS_KEY, "{not-json");
    const widths = loadColumnWidths();
    expect(widths.running).toBe(OPEN_COLUMN_DEFAULT_WIDTH_PX);
  });

  it("builds fixed px tracks and keeps collapsed at 40px", () => {
    const widths = loadColumnWidths();
    widths.running = 500;
    const template = buildGridTemplateColumns(
      allMeta({ backlog: true }),
      widths
    );
    expect(template).toBe(
      [
        "40px",
        `${OPEN_COLUMN_DEFAULT_WIDTH_PX}px`,
        "500px",
        `${OPEN_COLUMN_DEFAULT_WIDTH_PX}px`,
        `${OPEN_COLUMN_DEFAULT_WIDTH_PX}px`,
        `${OPEN_COLUMN_DEFAULT_WIDTH_PX}px`,
      ].join(" ")
    );
  });
});
