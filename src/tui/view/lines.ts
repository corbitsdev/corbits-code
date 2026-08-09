import type { StyledSegment } from "../markdown-parser.js";
import { color, type SemanticRole } from "../semantic-theme.js";
import { wrapLines } from "./height.js";
import type { Tone, ViewNode } from "./spec.js";
import { VIEW_GRID_MAX_ROWS } from "./spec.js";
import { GAP, PAD, toneRole, truncate } from "./registry.js";

export type StyledLine = StyledSegment[];

// Layout is shared across skins; the palette is not. The OpenTUI transcript
// paints the same view tree in the Corbits terminal palette, so callers may
// substitute the role→color resolver instead of re-implementing the layout.
export type ViewPalette = (role: SemanticRole) => string;

function colored(
  text: string,
  role: SemanticRole | undefined,
  palette: ViewPalette,
  extra?: Partial<StyledSegment>,
): StyledSegment {
  return { text, ...(role !== undefined ? { color: palette(role) } : {}), ...extra };
}

// Render a leaf-ish node to a single inline StyledLine (for use inside row/grid cells).
// If the node would produce multiple lines we take only the first (agent should use
// simple text nodes inside aligned structures).
function renderCell(node: ViewNode, available: number, palette: ViewPalette): StyledLine {
  const lines = viewToLines(node, available + PAD, palette); // +PAD so inner doesn't subtract again
  return lines[0] ?? [];
}

// Compute plain text width of a cell's first line for allocation (strips style).
function cellWidth(node: ViewNode, palette: ViewPalette): number {
  const line = renderCell(node, 1000, palette);
  return line.reduce((n, s) => n + s.text.length, 0);
}

// Pad a cell's segments to a target display width (left/right/center).
function padSegments(segments: StyledLine, width: number, align: "left" | "right" | "center" = "left"): StyledLine {
  const current = segments.reduce((n, s) => n + s.text.length, 0);
  if (current >= width) return segments.map((s) => ({ ...s, text: truncate(s.text, width) })); // crude per-seg, good enough
  const remain = width - current;
  if (align === "right") return [{ text: " ".repeat(remain) }, ...segments];
  if (align === "center") {
    const left = Math.floor(remain / 2);
    return [{ text: " ".repeat(left) }, ...segments, { text: " ".repeat(remain - left) }];
  }
  return [...segments, { text: " ".repeat(remain) }];
}

// Lay a view node out as flat styled lines, one per visual row. This is the
// single source of truth for view layout: the event log slices these by line so
// a tall view is cut at the viewport edge rather than overpainting past it.
export function viewToLines(
  node: ViewNode,
  columns: number,
  palette: ViewPalette = color,
): StyledLine[] {
  const available = Math.max(8, columns - PAD);

  switch (node.type) {
    case "divider":
      return [[colored("─".repeat(available), "muted", palette)]];

    case "text": {
      const role = toneRole(node.tone);
      const extra: Partial<StyledSegment> = {
        ...(node.bold ? { bold: true } : {}),
        ...(node.dim ? { dim: true } : {}),
      };
      return wrapLines(node.text, available).map((row) => [colored(row, role, palette, extra)]);
    }

    case "stack": {
      const lines: StyledLine[] = [];
      node.children.forEach((child, i) => {
        if (node.gap === 1 && i > 0) lines.push([]);
        lines.push(...viewToLines(child, columns, palette));
      });
      return lines;
    }

    case "row": {
      if (node.children.length === 0) return [[]];
      // Render children as inline segments on a single row. Use first line of each.
      const parts: StyledLine[] = node.children.map((c) => renderCell(c, available, palette));
      const out: StyledLine = [];
      const gapSeg = { text: " ".repeat(node.gap ?? 0) };
      parts.forEach((p, i) => {
        if (i > 0) out.push(gapSeg);
        out.push(...p);
      });
      return [out];
    }

    case "box": {
      const innerWidth = Math.max(4, available - (node.border ? 2 : 0) - (node.padding ? 2 : 0) * 2);
      const inner = node.children.flatMap((c) => viewToLines(c, innerWidth + PAD, palette));
      if (!node.border && !node.padding) return inner;
      const out: StyledLine[] = [];
      const border = "─".repeat(Math.max(1, innerWidth));
      if (node.border) out.push([colored(`┌${border}┐`, "muted", palette)]);
      const pad = node.padding ? " ".repeat(node.padding) : "";
      for (const ln of inner) {
        const content = ln.map((s) => ({ ...s }));
        out.push([colored(pad, undefined, palette), ...content, colored(pad, undefined, palette)]);
      }
      if (node.border) out.push([colored(`└${border}┘`, "muted", palette)]);
      return out;
    }

    case "grid": {
      const allRows = node.rows.slice(0, VIEW_GRID_MAX_ROWS);
      if (allRows.length === 0) return [];

      // For width allocation, measure the first-line width of each cell.
      const colCount = Math.max(...allRows.map((r) => r.length));
      const natural: number[] = [];
      for (let c = 0; c < colCount; c++) {
        let w = 0;
        for (const row of allRows) {
          const cell = row[c];
          if (cell) w = Math.max(w, cellWidth(cell, palette));
        }
        natural.push(Math.min(40, Math.max(1, w))); // cap like before
      }

      // Simple drop-right if too wide (port of allocate heuristic)
      let widths = [...natural];
      let cols = node.columns ?? [];
      const total = () => widths.reduce((n, w) => n + w, 0) + GAP * Math.max(0, widths.length - 1);
      while (total() > available && widths.length > 1) {
        widths.pop();
        cols = cols.slice(0, widths.length);
      }
      if (widths.length === 1 && widths[0]! > available) widths[0] = available;
      const leftover = available - total();
      if (leftover > 0 && widths.length > 0) widths[widths.length - 1] = widths[widths.length - 1]! + leftover;

      const lines: StyledLine[] = [];
      for (const r of allRows) {
        const cells = r.slice(0, widths.length);
        const segs: StyledLine = [];
        for (let i = 0; i < cells.length; i++) {
          const cellNode = cells[i]!;
          const cellLine = renderCell(cellNode, widths[i]!, palette);
          const align = (cols[i]?.align ?? "left") as "left" | "right" | "center";
          const padded = padSegments(cellLine, widths[i]!, align);
          segs.push(...padded);
          if (i < cells.length - 1) segs.push({ text: " ".repeat(GAP) });
        }
        lines.push(segs);
      }
      if (node.rows.length > allRows.length) {
        lines.push([
          colored(`+${node.rows.length - allRows.length} more`, "muted", palette, { dim: true }),
        ]);
      }
      return lines;
    }

    default:
      return [];
  }
}
