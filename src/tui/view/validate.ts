import { type ViewNode, type Tone, VIEW_MAX_NODES, VIEW_MAX_DEPTH } from "./spec.js";

// Boundary validation for an untrusted view spec (from the model or a converter).
// Hand-rolled rather than schema-derived so failures carry a node-path message the
// model can act on ("root.children[2].grid.rows: expected an array"). Once a node
// validates here the renderer trusts it.

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

interface Counter { nodes: number }

function validateNode(
  value: unknown,
  path: string,
  depth: number,
  counter: Counter,
): ViewValidation {
  if (depth > VIEW_MAX_DEPTH)
    return fail(path, `nesting exceeds the max depth of ${VIEW_MAX_DEPTH}`);
  if (++counter.nodes > VIEW_MAX_NODES)
    return fail(path, `spec exceeds the max of ${VIEW_MAX_NODES} nodes`);
  if (!isObject(value)) return fail(path, "expected a node object");
  const type = value.type;
  if (typeof type !== "string") return fail(path, "missing node type");

  switch (type) {
    case "divider":
      return { ok: true, node: { type } };

    case "text": {
      const t = checkString(value.text, `${path}.text`);
      if (typeof t !== "string") return t;
      const tone = checkTone(value.tone, `${path}.tone`);
      if (tone !== true) return tone;
      return {
        ok: true,
        node: {
          type,
          text: t,
          ...(value.tone !== undefined ? { tone: value.tone as Tone } : {}),
          ...(value.bold === true ? { bold: true } : {}),
          ...(value.dim === true ? { dim: true } : {}),
        },
      };
    }

    case "stack":
    case "row": {
      if (!Array.isArray(value.children)) return fail(`${path}.children`, "expected an array");
      const children: ViewNode[] = [];
      for (let i = 0; i < value.children.length; i++) {
        const child = validateNode(value.children[i], `${path}.children[${i}]`, depth + 1, counter);
        if (!child.ok) return child;
        children.push(child.node);
      }
      const g = value.gap;
      const gap = g === 0 || g === 1 ? (g as 0 | 1) : undefined;
      return {
        ok: true,
        node: { type: type as "stack" | "row", children, ...(gap !== undefined ? { gap } : {}) },
      };
    }

    case "box": {
      if (!Array.isArray(value.children)) return fail(`${path}.children`, "expected an array");
      const children: ViewNode[] = [];
      for (let i = 0; i < value.children.length; i++) {
        const child = validateNode(value.children[i], `${path}.children[${i}]`, depth + 1, counter);
        if (!child.ok) return child;
        children.push(child.node);
      }
      const border = value.border === true ? true : undefined;
      const p = value.padding;
      const padding = p === 0 || p === 1 ? (p as 0 | 1) : undefined;
      return {
        ok: true,
        node: {
          type,
          children,
          ...(border ? { border } : {}),
          ...(padding !== undefined ? { padding } : {}),
        },
      };
    }

    case "grid": {
      if (!Array.isArray(value.rows)) return fail(`${path}.rows`, "expected an array");
      const rows: ViewNode[][] = [];
      for (let i = 0; i < value.rows.length; i++) {
        const r = value.rows[i];
        const at = `${path}.rows[${i}]`;
        if (!Array.isArray(r)) return fail(at, "expected an array of nodes");
        const row: ViewNode[] = [];
        for (let j = 0; j < r.length; j++) {
          const cell = validateNode(r[j], `${at}[${j}]`, depth + 1, counter);
          if (!cell.ok) return cell;
          row.push(cell.node);
        }
        rows.push(row);
      }
      let columns: { align?: "left" | "right" | "center" }[] | undefined;
      if (value.columns !== undefined) {
        if (!Array.isArray(value.columns)) return fail(`${path}.columns`, "expected an array");
        columns = [];
        for (let i = 0; i < value.columns.length; i++) {
          const c = value.columns[i];
          const at = `${path}.columns[${i}]`;
          if (!isObject(c)) return fail(at, "expected an object");
          const align = c.align;
          if (align !== undefined && align !== "left" && align !== "right" && align !== "center") {
            return fail(`${at}.align`, 'expected "left", "right", or "center"');
          }
          columns.push(align !== undefined ? { align } : {});
        }
      }
      return { ok: true, node: { type, rows, ...(columns ? { columns } : {}) } };
    }

    default:
      return fail(`${path}.type`, `unknown node type "${type}"`);
  }
}

export function validateView(value: unknown): ViewValidation {
  return validateNode(value, "root", 0, { nodes: 0 });
}
