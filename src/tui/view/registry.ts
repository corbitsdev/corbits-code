import type { SemanticRole } from "../theme.js";
import type { Tone, ViewColumn } from "./spec.js";

export const GAP = 2;
export const PAD = 2;

export function toneRole(tone: Tone | undefined): SemanticRole | undefined {
  if (tone === undefined || tone === "default") return undefined;
  return tone;
}

function statusRole(value: string): SemanticRole {
  const v = value.toLowerCase();
  if (/(done|complete|merged|closed|active|success)/.test(v)) return "success";
  if (/(progress|started|review|pending)/.test(v)) return "accent";
  if (/(cancel|block|fail|reject|error)/.test(v)) return "danger";
  return "muted";
}

function priorityRole(value: string): SemanticRole {
  const v = value.toLowerCase();
  if (v === "urgent") return "danger";
  if (v === "high") return "warning";
  if (v === "medium") return "accent";
  return "muted";
}

export function cellRole(colorRole: ViewColumn["colorRole"], value: string): SemanticRole | undefined {
  if (colorRole === undefined) return undefined;
  if (colorRole === "status") return statusRole(value);
  if (colorRole === "priority") return priorityRole(value);
  return toneRole(colorRole);
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}

export function padCell(text: string, width: number, align: "left" | "right"): string {
  const t = truncate(text, width);
  if (t.length >= width) return t;
  const fill = " ".repeat(width - t.length);
  return align === "right" ? fill + t : t + fill;
}

// Allocate a width to each column so the row fits `available`, dropping columns
// from the right when space is tight (ported from the MCP table). Leftover space
// is distributed to the last column, not to a right-aligned first column.
// Returns the surviving columns and widths.
export function allocate(columns: ViewColumn[], rows: Record<string, string>[], available: number): { columns: ViewColumn[]; widths: number[] } {
  const natural = columns.map((c) =>
    Math.min(24, Math.max(c.header.length, ...rows.map((r) => (r[c.field] ?? "").length), 1)),
  );
  let cols = [...columns];
  let widths = [...natural];
  const total = (): number => widths.reduce((n, w) => n + w, 0) + GAP * (cols.length - 1);
  while (total() > available && cols.length > 1) {
    cols = cols.slice(0, -1);
    widths = widths.slice(0, -1);
  }
  if (widths.length === 1 && widths[0]! > available) widths[0] = available;
  const leftover = available - total();
  if (leftover > 0 && widths.length > 0) widths[widths.length - 1] = widths[widths.length - 1]! + leftover;
  return { columns: cols, widths };
}
