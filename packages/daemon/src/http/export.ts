export type ExportRunRow = {
  id: string;
  automationId: string;
  automationName: string;
  workspaceId: string;
  workspacePath: string;
  status: string;
  triggerKind: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  eventCount: number;
};

const CSV_COLUMNS: ReadonlyArray<keyof ExportRunRow> = [
  "id",
  "automationId",
  "automationName",
  "workspaceId",
  "workspacePath",
  "status",
  "triggerKind",
  "createdAt",
  "startedAt",
  "endedAt",
  "eventCount",
];

/** RFC-4180-style escaping: quote when the cell holds a comma, quote, or newline. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function runsToCsv(rows: ExportRunRow[]): string {
  const header = CSV_COLUMNS.join(",");
  const lines = rows.map((row) =>
    CSV_COLUMNS.map((col) => csvCell(row[col])).join(",")
  );
  return [header, ...lines].join("\r\n");
}

export function runsToJson(rows: ExportRunRow[]): string {
  return JSON.stringify(rows, null, 2);
}
