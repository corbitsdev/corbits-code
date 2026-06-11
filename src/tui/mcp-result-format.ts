// MCP tools return arbitrary JSON, often huge (Linear's list_projects is tens of
// thousands of characters). Rendering that verbatim freezes the TUI and is
// unreadable. This module turns an MCP result into a compact, bounded, readable
// form: a one-line preview ("12 projects") and a bounded multi-line body that
// summarizes each item by its salient fields rather than dumping raw JSON.

const MAX_ITEMS = 30;
const MAX_LINES = 60;
const MAX_CHARS = 4000;

export type McpResultSummary = {
  preview: string;
  full: string;
};

// Fields that make a record recognizable, in priority order.
const NAME_FIELDS = ["name", "title", "identifier", "label", "key", "summary", "id"];
const STATUS_FIELDS = ["status", "state", "type", "priority"];

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

export type McpRecords = { items: Record<string, unknown>[]; label: string };

// Pull out the array-of-records an MCP result is "about", if any: a bare array of
// objects, or the single array-valued key of a list wrapper. Returns null when
// the result is not a record list (a single record, a scalar, or plain text),
// in which case callers fall back to the text summary.
export function extractMcpRecords(content: string): McpRecords | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim());
  } catch {
    return null;
  }
  const isRecordArray = (v: unknown): v is Record<string, unknown>[] =>
    Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "object" && x !== null && !Array.isArray(x));

  if (isRecordArray(parsed)) return { items: parsed, label: "items" };
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const primary = primaryArray(obj);
    if (primary !== null && isRecordArray(primary.items)) return { items: primary.items, label: primary.key };
  }
  return null;
}

// Read a field that may be a scalar or a `{ name }` wrapper (Linear's shape).
export function recordScalar(record: Record<string, unknown>, key: string): string | null {
  return scalarField(record, key);
}

// A single record result (get_project, get_issue, save_*): a plain object that is
// not itself a list wrapper. Rendered as a detail card rather than a table.
export function extractMcpRecord(content: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  if (extractMcpRecords(content) !== null) return null;
  return parsed as Record<string, unknown>;
}

// Some MCP servers nest the human-readable value one level down (e.g. Linear
// returns status as `{ name: "In Progress" }`). Pull a scalar out of either.
function scalarField(record: Record<string, unknown>, key: string): string | null {
  const direct = asString(record[key]);
  if (direct !== null) return direct;
  const nested = record[key];
  if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    return asString((nested as Record<string, unknown>).name);
  }
  return null;
}

function summarizeItem(item: unknown): string {
  if (typeof item !== "object" || item === null) {
    const s = asString(item);
    return s ?? "{…}";
  }
  if (Array.isArray(item)) return `[${item.length} items]`;
  const record = item as Record<string, unknown>;
  const nonEmpty = (v: string | null): v is string => v !== null && v.length > 0;
  const name = NAME_FIELDS.map((f) => scalarField(record, f)).find(nonEmpty);
  const status = STATUS_FIELDS.map((f) => scalarField(record, f)).find(nonEmpty);
  if (name === undefined) {
    const keys = Object.keys(record).slice(0, 4).join(", ");
    return `{ ${keys}${Object.keys(record).length > 4 ? ", …" : ""} }`;
  }
  return status !== undefined ? `${name} — ${status}` : name;
}

function isScalar(v: unknown): boolean {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

// Find the array an object is "really" about: the common MCP list shape is a
// single array-valued key alongside only scalar pagination fields
// (e.g. { projects: [...], hasNextPage: false }). A record that merely contains
// a nested object or several arrays is treated as a record, not a list.
function primaryArray(obj: Record<string, unknown>): { key: string; items: unknown[] } | null {
  const arrayKeys = Object.entries(obj).filter(([, v]) => Array.isArray(v));
  if (arrayKeys.length !== 1) return null;
  const [key, items] = arrayKeys[0] as [string, unknown[]];
  const othersAllScalar = Object.entries(obj).every(([k, v]) => k === key || isScalar(v));
  return othersAllScalar ? { key, items } : null;
}

function bound(lines: string[]): string {
  let out = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) out.push(`… and ${lines.length - MAX_LINES} more`);
  let text = out.join("\n");
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n… (truncated)`;
  return text;
}

function summarizeList(label: string, items: unknown[]): McpResultSummary {
  const noun = items.length === 1 ? singular(label) : label;
  const lines = items.slice(0, MAX_ITEMS).map((it, i) => `${i + 1}. ${summarizeItem(it)}`);
  if (items.length > MAX_ITEMS) lines.push(`… and ${items.length - MAX_ITEMS} more`);
  return { preview: `${items.length} ${noun}`, full: bound(lines) };
}

function singular(label: string): string {
  return label.endsWith("s") ? label.slice(0, -1) : label;
}

export function formatMcpResult(content: string): McpResultSummary {
  const trimmed = content.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON (plain text / markdown from the server): show it, bounded.
    const lines = trimmed.split("\n");
    return { preview: `${lines.length} ${lines.length === 1 ? "line" : "lines"}`, full: bound(lines) };
  }

  if (Array.isArray(parsed)) return summarizeList("items", parsed);

  if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    const primary = primaryArray(obj);
    if (primary !== null) return summarizeList(primary.key, primary.items);
    // A single record (e.g. get_project): show its scalar fields, one per line.
    const lines = Object.entries(obj).map(([k, v]) => {
      const scalar = scalarField(obj, k);
      return scalar !== null ? `${k}: ${scalar}` : `${k}: ${Array.isArray(v) ? `[${v.length} items]` : "{…}"}`;
    });
    return { preview: summarizeItem(obj), full: bound(lines) };
  }

  // Bare scalar.
  return { preview: String(parsed), full: String(parsed) };
}
