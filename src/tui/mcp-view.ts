import { recordScalar, type McpRecords } from "./mcp-result-format.js";
import type { Tone, ViewColumn, ViewNode } from "./view/spec.js";

// Convert MCP results into view nodes so the heuristic (deterministic) rendering
// and any future agent-authored views share one renderer and one height function.
// The column/field choices reproduce the previous native MCP table and card.

const COLUMN_DEFS: { key: string; header: string; fields: string[]; colorRole?: ViewColumn["colorRole"]; date?: boolean }[] = [
  { key: "name", header: "Name", fields: ["name", "title", "identifier", "label", "key", "summary"] },
  { key: "status", header: "Status", fields: ["status", "state"], colorRole: "status" },
  { key: "priority", header: "Priority", fields: ["priority"], colorRole: "priority" },
  { key: "team", header: "Team", fields: ["team"] },
  { key: "target", header: "Target", fields: ["targetDate", "target", "dueDate"], date: true },
];

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

export function mcpRecordsToView(records: McpRecords): ViewNode {
  const present = COLUMN_DEFS.filter(
    (def) => def.key === "name" || records.items.some((r) => firstScalar(r, def.fields) !== undefined),
  );
  const columns: ViewColumn[] = [
    { header: "#", field: "__index", align: "right" },
    ...present.map((def) => ({ header: def.header, field: def.key, ...(def.colorRole !== undefined ? { colorRole: def.colorRole } : {}) })),
  ];
  const rows = records.items.map((record, i) => {
    const row: Record<string, string> = { __index: String(i + 1) };
    for (const def of present) {
      const v = firstScalar(record, def.fields);
      if (v !== undefined) row[def.key] = def.date === true ? v.slice(0, 10) : v;
    }
    return row;
  });
  return { type: "table", columns, rows };
}

export function mcpRecordToView(record: Record<string, unknown>): ViewNode {
  const titleKey = TITLE_FIELDS.find((f) => (recordScalar(record, f) ?? "").length > 0);
  const title = titleKey !== undefined ? recordScalar(record, titleKey) ?? undefined : undefined;
  const present = Object.keys(record).filter(
    (k) => k !== titleKey && !DETAIL_HIDE.has(k) && (recordScalar(record, k) ?? "").length > 0,
  );
  const ordered = [...DETAIL_ORDER.filter((k) => present.includes(k)), ...present.filter((k) => !DETAIL_ORDER.includes(k))];
  const fields = ordered.map((key) => {
    const raw = recordScalar(record, key) ?? "";
    const value = DATE_KEYS.has(key) ? raw.slice(0, 10) : raw;
    const tone: Tone | undefined =
      key === "status" || key === "state" ? statusTone(value) : key === "priority" ? priorityTone(value) : undefined;
    return { label: humanizeField(key), value, ...(tone !== undefined ? { tone } : {}) };
  });
  return { type: "card", fields, ...(title !== undefined ? { title } : {}) };
}
