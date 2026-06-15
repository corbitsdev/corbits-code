import type { StyledSegment } from "../markdown-parser.js";
import { color, type SemanticRole } from "../theme.js";
import { wrapLines } from "./height.js";
import type { Tone, ViewNode } from "./spec.js";
import { VIEW_TABLE_MAX_ROWS } from "./spec.js";
import { GAP, PAD, allocate, cellRole, padCell, toneRole, truncate } from "./registry.js";

export type StyledLine = StyledSegment[];

function colored(text: string, role: SemanticRole | undefined, extra?: Partial<StyledSegment>): StyledSegment {
  return { text, ...(role !== undefined ? { color: color(role) } : {}), ...extra };
}

function badgeLine(badges: { label: string; tone?: Tone }[]): StyledLine {
  return badges.flatMap((b, i) => {
    const role = toneRole(b.tone) ?? "accent";
    const prefix = i > 0 ? " " : "";
    return [colored(`${prefix}[${b.label}]`, role)];
  });
}

// Lay a view node out as flat styled lines, one per visual row. This is the
// single source of truth for view layout: the event log slices these by line so
// a tall view (a long table, a deep stack) is cut at the viewport edge rather
// than overpainting past it.
export function viewToLines(node: ViewNode, columns: number): StyledLine[] {
  const available = Math.max(8, columns - PAD);

  switch (node.type) {
    case "divider":
      return [[colored("─".repeat(available), "muted")]];
    case "text": {
      const role = toneRole(node.tone);
      const extra: Partial<StyledSegment> = {
        ...(node.bold ? { bold: true } : {}),
        ...(node.dim ? { dim: true } : {}),
      };
      return wrapLines(node.value, available).map((row) => [colored(row, role, extra)]);
    }
    case "heading": {
      const role: SemanticRole = node.level === 3 ? "muted" : "accent";
      return wrapLines(node.value, available).map((row) => [colored(row, role, { bold: true })]);
    }
    case "badge":
      return [badgeLine([{ label: node.label, ...(node.tone !== undefined ? { tone: node.tone } : {}) }])];
    case "progress": {
      const max = node.max ?? 100;
      const ratio = max > 0 ? Math.max(0, Math.min(1, node.value / max)) : 0;
      const barWidth = Math.max(4, Math.min(24, available - 12));
      const filled = Math.round(ratio * barWidth);
      const bar = "▰".repeat(filled) + "▱".repeat(barWidth - filled);
      const label = node.label !== undefined ? ` ${truncate(node.label, available - barWidth - 6)}` : "";
      return [[colored(bar, "accent"), colored(` ${Math.round(ratio * 100)}%${label}`, "muted")]];
    }
    case "keyValue": {
      const labelWidth = Math.min(20, Math.max(0, ...node.pairs.map((p) => p.label.length)));
      return node.pairs.map((p) => [
        colored(padCell(p.label, labelWidth, "left"), "muted"),
        { text: " ".repeat(GAP) },
        colored(truncate(p.value, available - labelWidth - GAP), toneRole(p.tone)),
      ]);
    }
    case "list":
      return node.items.map((item, i) => {
        const marker = node.ordered ? `${i + 1}. ` : "• ";
        return [colored(marker, "muted"), { text: truncate(item, available - marker.length) }];
      });
    case "table": {
      const rows = node.rows.slice(0, VIEW_TABLE_MAX_ROWS);
      const { columns: cols, widths } = allocate(node.columns, node.rows, available);
      const rowLine = (cells: { text: string; role: SemanticRole | undefined }[]): StyledLine =>
        cells.flatMap((cell, i) => [
          colored(padCell(cell.text, widths[i]!, cols[i]!.align ?? "left"), cell.role),
          ...(i < cols.length - 1 ? [{ text: " ".repeat(GAP) }] : []),
        ]);
      const lines: StyledLine[] = [
        cols.flatMap((c, i) => [
          colored(padCell(c.header, widths[i]!, c.align ?? "left"), "muted", { bold: true }),
          ...(i < cols.length - 1 ? [colored(" ".repeat(GAP), "muted", { bold: true })] : []),
        ]),
        ...rows.map((r) =>
          rowLine(cols.map((c) => ({ text: r[c.field] ?? "", role: cellRole(c.colorRole, r[c.field] ?? "") }))),
        ),
      ];
      if (node.rows.length > rows.length) {
        lines.push([colored(`+${node.rows.length - rows.length} more`, "muted", { dim: true })]);
      }
      return lines;
    }
    case "card": {
      const lines: StyledLine[] = [];
      if (node.title !== undefined) lines.push([colored(truncate(node.title, available), "accent", { bold: true })]);
      if (node.subtitle !== undefined) lines.push([colored(truncate(node.subtitle, available), "muted")]);
      const labelWidth = Math.min(16, Math.max(0, ...node.fields.map((f) => f.label.length)));
      for (const f of node.fields) {
        lines.push([
          colored(padCell(f.label, labelWidth, "left"), "muted"),
          { text: " ".repeat(GAP) },
          colored(truncate(f.value, available - labelWidth - GAP), toneRole(f.tone)),
        ]);
      }
      if (node.badges !== undefined && node.badges.length > 0) lines.push(badgeLine(node.badges));
      return lines;
    }
    case "stack": {
      const lines: StyledLine[] = [];
      node.children.forEach((child, i) => {
        if (node.gap === 1 && i > 0) lines.push([]);
        lines.push(...viewToLines(child, columns));
      });
      return lines;
    }
  }
}
