import {
  type ViewNode,
  type Tone,
  type ViewColumn,
  type KeyValuePair,
  VIEW_MAX_NODES,
  VIEW_MAX_DEPTH,
} from "./spec.js";

// Boundary validation for an untrusted view spec (from the model or a converter).
// Hand-rolled rather than schema-derived so failures carry a node-path message the
// model can act on ("root.children[2].table.rows: expected an array"). Once a node
// validates here the registry trusts it. Returns the typed node or a single,
// specific error string.

export type ViewValidation = { ok: true; node: ViewNode } | { ok: false; error: string };

const TONES = new Set<Tone>(["default", "muted", "success", "warning", "danger", "accent"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(path: string, msg: string): { ok: false; error: string } {
  return { ok: false, error: `${path}: ${msg}` };
}

function checkString(v: unknown, path: string): string | { ok: false; error: string } {
  return typeof v === "string" ? v : fail(path, "expected a string");
}

function checkTone(v: unknown, path: string): true | { ok: false; error: string } {
  if (v === undefined) return true;
  if (typeof v === "string" && TONES.has(v as Tone)) return true;
  return fail(path, `invalid tone "${String(v)}"`);
}

function checkPairs(v: unknown, path: string): KeyValuePair[] | { ok: false; error: string } {
  if (!Array.isArray(v)) return fail(path, "expected an array");
  const out: KeyValuePair[] = [];
  for (let i = 0; i < v.length; i++) {
    const p = v[i];
    const at = `${path}[${i}]`;
    if (!isObject(p)) return fail(at, "expected an object");
    const label = checkString(p.label, `${at}.label`);
    if (typeof label !== "string") return label;
    const value = checkString(p.value, `${at}.value`);
    if (typeof value !== "string") return value;
    const tone = checkTone(p.tone, `${at}.tone`);
    if (tone !== true) return tone;
    out.push({ label, value, ...(p.tone !== undefined ? { tone: p.tone as Tone } : {}) });
  }
  return out;
}

type Counter = { nodes: number };

function validateNode(value: unknown, path: string, depth: number, counter: Counter): ViewValidation {
  if (depth > VIEW_MAX_DEPTH) return fail(path, `nesting exceeds the max depth of ${VIEW_MAX_DEPTH}`);
  if (++counter.nodes > VIEW_MAX_NODES) return fail(path, `spec exceeds the max of ${VIEW_MAX_NODES} nodes`);
  if (!isObject(value)) return fail(path, "expected a node object");
  const type = value.type;
  if (typeof type !== "string") return fail(path, "missing node type");

  const str = (key: string): string | { ok: false; error: string } => checkString(value[key], `${path}.${key}`);

  switch (type) {
    case "divider":
      return { ok: true, node: { type } };
    case "text": {
      const v = str("value");
      if (typeof v !== "string") return v;
      const tone = checkTone(value.tone, `${path}.tone`);
      if (tone !== true) return tone;
      return { ok: true, node: { type, value: v, ...(value.tone !== undefined ? { tone: value.tone as Tone } : {}), ...(value.bold === true ? { bold: true } : {}), ...(value.dim === true ? { dim: true } : {}) } };
    }
    case "heading": {
      const v = str("value");
      if (typeof v !== "string") return v;
      const level = value.level === undefined ? undefined : value.level;
      if (level !== undefined && level !== 1 && level !== 2 && level !== 3) return fail(`${path}.level`, "expected 1, 2, or 3");
      return { ok: true, node: { type, value: v, ...(level !== undefined ? { level: level as 1 | 2 | 3 } : {}) } };
    }
    case "badge": {
      const label = str("label");
      if (typeof label !== "string") return label;
      const tone = checkTone(value.tone, `${path}.tone`);
      if (tone !== true) return tone;
      return { ok: true, node: { type, label, ...(value.tone !== undefined ? { tone: value.tone as Tone } : {}) } };
    }
    case "progress": {
      if (typeof value.value !== "number") return fail(`${path}.value`, "expected a number");
      if (value.max !== undefined && typeof value.max !== "number") return fail(`${path}.max`, "expected a number");
      if (value.label !== undefined && typeof value.label !== "string") return fail(`${path}.label`, "expected a string");
      return { ok: true, node: { type, value: value.value, ...(value.max !== undefined ? { max: value.max as number } : {}), ...(value.label !== undefined ? { label: value.label as string } : {}) } };
    }
    case "keyValue": {
      const pairs = checkPairs(value.pairs, `${path}.pairs`);
      if (!Array.isArray(pairs)) return pairs;
      return { ok: true, node: { type, pairs } };
    }
    case "list": {
      if (!Array.isArray(value.items)) return fail(`${path}.items`, "expected an array");
      const items: string[] = [];
      for (let i = 0; i < value.items.length; i++) {
        const it = value.items[i];
        if (typeof it !== "string") return fail(`${path}.items[${i}]`, "expected a string");
        items.push(it);
      }
      return { ok: true, node: { type, items, ...(value.ordered === true ? { ordered: true } : {}) } };
    }
    case "table": {
      if (!Array.isArray(value.columns)) return fail(`${path}.columns`, "expected an array");
      const columns: ViewColumn[] = [];
      for (let i = 0; i < value.columns.length; i++) {
        const c = value.columns[i];
        const at = `${path}.columns[${i}]`;
        if (!isObject(c)) return fail(at, "expected an object");
        if (typeof c.header !== "string") return fail(`${at}.header`, "expected a string");
        if (typeof c.field !== "string") return fail(`${at}.field`, "expected a string");
        const col: ViewColumn = { header: c.header, field: c.field };
        if (c.align === "right") col.align = "right";
        if (typeof c.colorRole === "string") col.colorRole = c.colorRole as NonNullable<ViewColumn["colorRole"]>;
        columns.push(col);
      }
      if (!Array.isArray(value.rows)) return fail(`${path}.rows`, "expected an array");
      const rows: Record<string, string>[] = [];
      for (let i = 0; i < value.rows.length; i++) {
        const r = value.rows[i];
        if (!isObject(r)) return fail(`${path}.rows[${i}]`, "expected an object");
        const row: Record<string, string> = {};
        for (const [k, val] of Object.entries(r)) row[k] = typeof val === "string" ? val : String(val);
        rows.push(row);
      }
      return { ok: true, node: { type, columns, rows } };
    }
    case "card": {
      const fields = checkPairs(value.fields ?? [], `${path}.fields`);
      if (!Array.isArray(fields)) return fields;
      let badges: { label: string; tone?: Tone }[] | undefined;
      if (value.badges !== undefined) {
        if (!Array.isArray(value.badges)) return fail(`${path}.badges`, "expected an array");
        badges = [];
        for (let i = 0; i < value.badges.length; i++) {
          const b = value.badges[i];
          const at = `${path}.badges[${i}]`;
          if (!isObject(b) || typeof b.label !== "string") return fail(at, "expected a { label } object");
          const tone = checkTone(b.tone, `${at}.tone`);
          if (tone !== true) return tone;
          badges.push({ label: b.label, ...(b.tone !== undefined ? { tone: b.tone as Tone } : {}) });
        }
      }
      if (value.title !== undefined && typeof value.title !== "string") return fail(`${path}.title`, "expected a string");
      if (value.subtitle !== undefined && typeof value.subtitle !== "string") return fail(`${path}.subtitle`, "expected a string");
      return { ok: true, node: { type, fields, ...(value.title !== undefined ? { title: value.title as string } : {}), ...(value.subtitle !== undefined ? { subtitle: value.subtitle as string } : {}), ...(badges !== undefined ? { badges } : {}) } };
    }
    case "stack": {
      if (!Array.isArray(value.children)) return fail(`${path}.children`, "expected an array");
      const children: ViewNode[] = [];
      for (let i = 0; i < value.children.length; i++) {
        const child = validateNode(value.children[i], `${path}.children[${i}]`, depth + 1, counter);
        if (!child.ok) return child;
        children.push(child.node);
      }
      const gap = value.gap === 0 || value.gap === 1 ? (value.gap as 0 | 1) : undefined;
      return { ok: true, node: { type, children, ...(gap !== undefined ? { gap } : {}) } };
    }
    default:
      return fail(`${path}.type`, `unknown node type "${type}"`);
  }
}

export function validateView(value: unknown): ViewValidation {
  return validateNode(value, "root", 0, { nodes: 0 });
}
