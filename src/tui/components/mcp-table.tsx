import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { color, type SemanticRole } from "../theme.js";
import { recordScalar, type McpRecords } from "../mcp-result-format.js";

// Render every row and let the scroll viewport handle overflow. A high sanity
// cap only guards against a pathologically large list locking up the renderer.
const MAX_ROWS = 200;
const COL_GAP = 2;

type ColumnKind = "index" | "name" | "status" | "priority" | "team" | "date" | "text";

type Column = {
  header: string;
  kind: ColumnKind;
  fields: string[];
  // Max width before the flexible name column absorbs the remainder.
  cap: number;
  min: number;
};

// Candidate columns in priority order. A column is shown only if at least one
// record yields a value for it, so a list of issues and a list of projects each
// get a sensible shape without per-server knowledge.
const CANDIDATES: Column[] = [
  { header: "Name", kind: "name", fields: ["name", "title", "identifier", "label", "key", "summary"], cap: 60, min: 16 },
  { header: "Status", kind: "status", fields: ["status", "state"], cap: 16, min: 6 },
  { header: "Priority", kind: "priority", fields: ["priority"], cap: 9, min: 4 },
  { header: "Team", kind: "team", fields: ["team"], cap: 14, min: 4 },
  { header: "Target", kind: "date", fields: ["targetDate", "target", "dueDate"], cap: 10, min: 6 },
];

function cellValue(record: Record<string, unknown>, col: Column): string {
  for (const f of col.fields) {
    const v = recordScalar(record, f);
    if (v !== null && v.length > 0) return col.kind === "date" ? v.slice(0, 10) : v;
  }
  return "";
}

function statusRole(value: string): SemanticRole {
  const v = value.toLowerCase();
  if (/(done|complete|merged|closed)/.test(v)) return "success";
  if (/(progress|started|active|review)/.test(v)) return "accent";
  if (/(cancel|block|fail|reject)/.test(v)) return "danger";
  return "muted";
}

function priorityRole(value: string): SemanticRole {
  const v = value.toLowerCase();
  if (v === "urgent") return "danger";
  if (v === "high") return "warning";
  if (v === "medium") return "accent";
  return "muted";
}

function cellRole(kind: ColumnKind, value: string): SemanticRole | undefined {
  if (value.length === 0) return "muted";
  if (kind === "status") return statusRole(value);
  if (kind === "priority") return priorityRole(value);
  if (kind === "index") return "muted";
  if (kind === "date" || kind === "team") return "muted";
  return undefined;
}

function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

// Choose the visible columns and assign each a width that fits `available`. The
// name column flexes to absorb the remainder; optional columns are dropped from
// the right when space is tight so the table never overflows and wraps.
function layout(items: Record<string, unknown>[], available: number): { col: Column; width: number }[] {
  const present = CANDIDATES.filter((c) => c.kind === "name" || items.some((r) => cellValue(r, c).length > 0));
  const indexWidth = Math.max(1, String(items.length).length);

  let cols = present;
  while (cols.length > 1) {
    const fixed = cols.filter((c) => c.kind !== "name");
    const widths = new Map<Column, number>();
    for (const c of fixed) {
      const contentMax = Math.max(c.header.length, ...items.map((r) => cellValue(r, c).length));
      widths.set(c, Math.min(c.cap, Math.max(c.min, contentMax)));
    }
    const fixedTotal = [...widths.values()].reduce((n, w) => n + w, 0);
    const gaps = (cols.length + 1) * COL_GAP; // index col + each data col, plus trailing
    const nameWidth = available - indexWidth - fixedTotal - gaps;
    if (nameWidth >= 16 || cols.length === 2) {
      const name = cols.find((c) => c.kind === "name")!;
      const ordered: { col: Column; width: number }[] = [
        { col: { header: "#", kind: "index", fields: [], cap: indexWidth, min: indexWidth }, width: indexWidth },
        { col: name, width: Math.max(8, nameWidth) },
        ...fixed.map((c) => ({ col: c, width: widths.get(c)! })),
      ];
      return ordered;
    }
    // Too tight: drop the lowest-priority optional (rightmost non-name) column.
    const dropIdx = cols.map((c) => c.kind).lastIndexOf(cols[cols.length - 1]!.kind);
    cols = cols.filter((_, i) => i !== dropIdx);
  }
  return [{ col: cols[0]!, width: available }];
}

export type McpTableProps = {
  records: McpRecords;
  width: number;
};

export function mcpTableRowCount(itemCount: number): number {
  const shown = Math.min(itemCount, MAX_ROWS);
  // header + rows + ("+N more" footer only past the sanity cap)
  return 1 + shown + (itemCount > shown ? 1 : 0);
}

// Fields shown first (in this order) in a record card; any other scalar fields
// follow. Noisy identifiers and timestamps are hidden — they add no value.
const DETAIL_ORDER = ["status", "state", "priority", "team", "lead", "assignee", "startDate", "targetDate", "dueDate", "url", "description", "summary"];
const DETAIL_HIDE = new Set(["id", "createdAt", "updatedAt", "archivedAt", "completedAt", "canceledAt", "icon", "color", "slug"]);
const TITLE_FIELDS = ["name", "title", "identifier", "label", "key"];
const DATE_FIELDS = new Set(["startDate", "targetDate", "dueDate"]);

function humanizeField(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

function detailRole(key: string, value: string): SemanticRole | undefined {
  if (key === "status" || key === "state") return statusRole(value);
  if (key === "priority") return priorityRole(value);
  return undefined;
}

export function mcpRecordCardRowCount(record: Record<string, unknown>): number {
  return 1 + detailRows(record).length;
}

function detailRows(record: Record<string, unknown>): { key: string; value: string }[] {
  const title = TITLE_FIELDS.find((f) => (recordScalar(record, f) ?? "").length > 0);
  const present = Object.keys(record).filter(
    (k) => k !== title && !DETAIL_HIDE.has(k) && (recordScalar(record, k) ?? "").length > 0,
  );
  const ordered = [
    ...DETAIL_ORDER.filter((k) => present.includes(k)),
    ...present.filter((k) => !DETAIL_ORDER.includes(k)),
  ];
  return ordered.map((key) => {
    const raw = recordScalar(record, key) ?? "";
    return { key, value: DATE_FIELDS.has(key) ? raw.slice(0, 10) : raw };
  });
}

export type McpRecordCardProps = {
  record: Record<string, unknown>;
  width: number;
};

export function McpRecordCard({ record, width }: McpRecordCardProps): ReactNode {
  const available = Math.max(24, width - 2);
  const title = TITLE_FIELDS.map((f) => recordScalar(record, f)).find((v): v is string => v !== null && v.length > 0);
  const rows = detailRows(record);
  const labelWidth = Math.min(16, Math.max(0, ...rows.map((r) => humanizeField(r.key).length)));
  const valueWidth = Math.max(8, available - labelWidth - COL_GAP);

  return (
    <Box flexDirection="column">
      {title !== undefined && (
        <Text bold color={color("accent")}>
          {truncate(title, available)}
        </Text>
      )}
      {rows.map((r, i) => {
        const role = detailRole(r.key, r.value);
        return (
          <Text key={i}>
            <Text color={color("muted")}>{pad(humanizeField(r.key), labelWidth)}</Text>
            {" ".repeat(COL_GAP)}
            <Text {...(role !== undefined ? { color: color(role) } : {})}>{truncate(r.value, valueWidth)}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

export function McpTable({ records, width }: McpTableProps): ReactNode {
  const available = Math.max(24, width - 2);
  const cols = layout(records.items, available);
  const shown = records.items.slice(0, MAX_ROWS);

  return (
    <Box flexDirection="column">
      <Text>
        {cols.map((c, i) => (
          <Text key={i} color={color("muted")} bold>
            {pad(truncate(c.col.header, c.width), c.width)}
            {i < cols.length - 1 ? " ".repeat(COL_GAP) : ""}
          </Text>
        ))}
      </Text>
      {shown.map((record, r) => (
        <Text key={r}>
          {cols.map((c, i) => {
            const raw = c.col.kind === "index" ? String(r + 1) : cellValue(record, c.col);
            const text = pad(truncate(raw, c.width), c.width);
            const role = cellRole(c.col.kind, raw);
            return (
              <Text key={i} {...(role !== undefined ? { color: color(role) } : {})}>
                {text}
                {i < cols.length - 1 ? " ".repeat(COL_GAP) : ""}
              </Text>
            );
          })}
        </Text>
      ))}
      {records.items.length > shown.length && (
        <Text color={color("muted")} dimColor>
          +{records.items.length - shown.length} more {records.label}
        </Text>
      )}
    </Box>
  );
}
