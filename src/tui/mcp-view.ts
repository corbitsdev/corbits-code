import { recordScalar, type McpRecords } from "./mcp-result-format.js";
import type { Tone, ViewNode } from "./view/spec.js";

// Convert MCP results into view nodes using only generic layout primitives.
// This keeps structures dynamic (agent composes the same way) and avoids any
// hardcoded widget catalog. We use grid for tabular record lists and a stack
// of rows for single-record detail so the output is aligned and readable.

const NAME_FIELDS = ["name", "title", "identifier", "label", "key", "summary"];
const STATUS_FIELDS = ["status", "state"];
const PRIORITY_FIELDS = ["priority"];
const TEAM_FIELDS = ["team"];
const TARGET_FIELDS = ["targetDate", "target", "dueDate"];

const DETAIL_ORDER = ["status", "state", "priority", "team", "lead", "assignee", "startDate", "targetDate", "dueDate", "url", "description", "summary"];
const DETAIL_HIDE = new Set(["id", "createdAt", "updatedAt", "archivedAt", "completedAt", "canceledAt", "icon", "color", "slug"]);
const TITLE_FIELDS = ["name", "title", "identifier", "label", "key"];
const DATE_KEYS = new Set(["startDate", "targetDate", "dueDate"]);

function firstScalar(record: Record<string, unknown>, fields: string[]): string | undefined {
  for (const f of fields) {
    const v = recordScalar(record, f);
    if (v !== null && v.length > 0) return v;
  }
  return undefined;
}

function humanizeField(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function statusTone(value: string): Tone {
  const v = value.toLowerCase();
  if (/(done|complete|merged|closed|active)/.test(v)) return "success";
  if (/(progress|started|review)/.test(v)) return "accent";
  if (/(cancel|block|fail|reject)/.test(v)) return "danger";
  return "muted";
}

function priorityTone(value: string): Tone {
  const v = value.toLowerCase();
  if (v === "urgent") return "danger";
  if (v === "high") return "warning";
  if (v === "medium") return "accent";
  return "muted";
}

function textNode(t: string, tone?: Tone, bold?: boolean): ViewNode {
  return { type: "text", text: t, ...(tone ? { tone } : {}), ...(bold ? { bold: true } : {}) };
}

export function mcpRecordsToView(records: McpRecords): ViewNode {
  // Build a header + data rows using grid for alignment (no "table" widget).
  const hasStatus = records.items.some((r) => firstScalar(r, STATUS_FIELDS));
  const hasPriority = records.items.some((r) => firstScalar(r, PRIORITY_FIELDS));
  const hasTeam = records.items.some((r) => firstScalar(r, TEAM_FIELDS));
  const hasTarget = records.items.some((r) => firstScalar(r, TARGET_FIELDS));

  type ColDef = { key: string; header: string; get: (r: Record<string, unknown>, i: number) => string; tone?: (v: string) => Tone };
  const colDefs: ColDef[] = [
    { key: "#", header: "#", get: (_r, i) => String(i + 1) },
    { key: "name", header: "Name", get: (r) => firstScalar(r, NAME_FIELDS) ?? "" },
  ];
  if (hasStatus) colDefs.push({ key: "status", header: "Status", get: (r) => firstScalar(r, STATUS_FIELDS) ?? "", tone: statusTone });
  if (hasPriority) colDefs.push({ key: "priority", header: "Priority", get: (r) => firstScalar(r, PRIORITY_FIELDS) ?? "", tone: priorityTone });
  if (hasTeam) colDefs.push({ key: "team", header: "Team", get: (r) => firstScalar(r, TEAM_FIELDS) ?? "" });
  if (hasTarget) colDefs.push({ key: "target", header: "Target", get: (r) => { const v = firstScalar(r, TARGET_FIELDS) ?? ""; return v.length > 10 ? v.slice(0, 10) : v; } });

  const headerRow: ViewNode[] = colDefs.map((d) => textNode(d.header, "muted", true));
  const dataRows: ViewNode[][] = records.items.map((rec, i) =>
    colDefs.map((d) => {
      const v = d.get(rec, i);
      const t = d.tone ? d.tone(v) : undefined;
      return textNode(v, t);
    }),
  );

  return {
    type: "grid",
    columns: colDefs.map((d) => ({ align: d.key === "#" ? "right" : "left" })),
    rows: [headerRow, ...dataRows],
  };
}

export function mcpRecordToView(record: Record<string, unknown>): ViewNode {
  const titleKey = TITLE_FIELDS.find((f) => (recordScalar(record, f) ?? "").length > 0);
  const title = titleKey !== undefined ? recordScalar(record, titleKey) ?? undefined : undefined;

  const present = Object.keys(record).filter(
    (k) => k !== titleKey && !DETAIL_HIDE.has(k) && (recordScalar(record, k) ?? "").length > 0,
  );
  const ordered = [...DETAIL_ORDER.filter((k) => present.includes(k)), ...present.filter((k) => !DETAIL_ORDER.includes(k))];

  const children: ViewNode[] = [];
  if (title) children.push(textNode(title, "accent", true));

  for (const key of ordered) {
    const raw = recordScalar(record, key) ?? "";
    const value = DATE_KEYS.has(key) ? raw.slice(0, 10) : raw;
    const tone: Tone | undefined =
      key === "status" || key === "state" ? statusTone(value) : key === "priority" ? priorityTone(value) : undefined;
    const label = humanizeField(key);
    // Use a row of two texts for "Label  value" alignment within the record.
    children.push({
      type: "row",
      gap: 1,
      children: [textNode(label, "muted"), textNode(value, tone)],
    });
  }

  // Wrap in a stack (optionally a box if we want visual group; start without border to keep compact)
  return { type: "stack", gap: 0, children };
}
