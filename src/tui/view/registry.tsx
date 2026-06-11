import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { color, type SemanticRole } from "../theme.js";
import type { Tone, ViewColumn, ViewNode } from "./spec.js";
import { VIEW_TABLE_MAX_ROWS } from "./spec.js";

const GAP = 2;
const PAD = 2;

function toneRole(tone: Tone | undefined): SemanticRole | undefined {
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

function cellRole(colorRole: ViewColumn["colorRole"], value: string): SemanticRole | undefined {
  if (colorRole === undefined) return undefined;
  if (colorRole === "status") return statusRole(value);
  if (colorRole === "priority") return priorityRole(value);
  return toneRole(colorRole);
}

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}

function padCell(text: string, width: number, align: "left" | "right"): string {
  const t = truncate(text, width);
  if (t.length >= width) return t;
  const fill = " ".repeat(width - t.length);
  return align === "right" ? fill + t : t + fill;
}

function colorProps(role: SemanticRole | undefined): { color?: string } {
  return role !== undefined ? { color: color(role) } : {};
}

// Allocate a width to each column so the row fits `available`, dropping columns
// from the right when space is tight (ported from the MCP table) and letting the
// first column absorb any leftover. Returns the surviving columns and widths.
function allocate(columns: ViewColumn[], rows: Record<string, string>[], available: number): { columns: ViewColumn[]; widths: number[] } {
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
  if (leftover > 0) widths[0] = widths[0]! + leftover;
  return { columns: cols, widths };
}

function renderTable(node: Extract<ViewNode, { type: "table" }>, columns: number): ReactNode {
  const available = Math.max(8, columns - PAD);
  const rows = node.rows.slice(0, VIEW_TABLE_MAX_ROWS);
  const { columns: cols, widths } = allocate(node.columns, node.rows, available);
  const row = (cells: { text: string; role: SemanticRole | undefined }[]): ReactNode =>
    cells.map((cell, i) => (
      <Text key={i} {...colorProps(cell.role)}>
        {padCell(cell.text, widths[i]!, cols[i]!.align ?? "left")}
        {i < cols.length - 1 ? " ".repeat(GAP) : ""}
      </Text>
    ));
  return (
    <Box flexDirection="column">
      <Text bold color={color("muted")}>
        {cols.map((c, i) => (
          <Text key={i}>
            {padCell(c.header, widths[i]!, c.align ?? "left")}
            {i < cols.length - 1 ? " ".repeat(GAP) : ""}
          </Text>
        ))}
      </Text>
      {rows.map((r, ri) => (
        <Text key={ri}>{row(cols.map((c) => ({ text: r[c.field] ?? "", role: cellRole(c.colorRole, r[c.field] ?? "") })))}</Text>
      ))}
      {node.rows.length > rows.length && (
        <Text color={color("muted")} dimColor>
          +{node.rows.length - rows.length} more
        </Text>
      )}
    </Box>
  );
}

function renderBadgeRow(badges: { label: string; tone?: Tone }[]): ReactNode {
  return (
    <Text>
      {badges.map((b, i) => (
        <Text key={i} {...colorProps(toneRole(b.tone) ?? "accent")}>
          {i > 0 ? " " : ""}[{b.label}]
        </Text>
      ))}
    </Text>
  );
}

export function renderNode(node: ViewNode, columns: number): ReactNode {
  const available = Math.max(8, columns - PAD);
  switch (node.type) {
    case "divider":
      return <Text color={color("muted")}>{"─".repeat(available)}</Text>;
    case "text":
      return (
        <Text wrap="wrap" {...colorProps(toneRole(node.tone))} {...(node.bold ? { bold: true } : {})} {...(node.dim ? { dimColor: true } : {})}>
          {node.value}
        </Text>
      );
    case "heading": {
      const role: SemanticRole = node.level === 1 ? "accent" : node.level === 2 ? "accent" : "muted";
      return (
        <Text bold color={color(role)} wrap="wrap">
          {node.value}
        </Text>
      );
    }
    case "badge":
      return renderBadgeRow([{ label: node.label, ...(node.tone !== undefined ? { tone: node.tone } : {}) }]);
    case "progress": {
      const max = node.max ?? 100;
      const ratio = max > 0 ? Math.max(0, Math.min(1, node.value / max)) : 0;
      const barWidth = Math.max(4, Math.min(24, available - 12));
      const filled = Math.round(ratio * barWidth);
      const bar = "▰".repeat(filled) + "▱".repeat(barWidth - filled);
      const label = node.label !== undefined ? ` ${truncate(node.label, available - barWidth - 6)}` : "";
      return (
        <Text>
          <Text color={color("accent")}>{bar}</Text>
          <Text color={color("muted")}> {Math.round(ratio * 100)}%{label}</Text>
        </Text>
      );
    }
    case "keyValue": {
      const labelWidth = Math.min(20, Math.max(0, ...node.pairs.map((p) => p.label.length)));
      return (
        <Box flexDirection="column">
          {node.pairs.map((p, i) => (
            <Text key={i}>
              <Text color={color("muted")}>{padCell(p.label, labelWidth, "left")}</Text>
              {" ".repeat(GAP)}
              <Text {...colorProps(toneRole(p.tone))}>{truncate(p.value, available - labelWidth - GAP)}</Text>
            </Text>
          ))}
        </Box>
      );
    }
    case "list":
      return (
        <Box flexDirection="column">
          {node.items.map((item, i) => {
            const marker = node.ordered ? `${i + 1}. ` : "• ";
            return (
              <Text key={i}>
                <Text color={color("muted")}>{marker}</Text>
                {truncate(item, available - marker.length)}
              </Text>
            );
          })}
        </Box>
      );
    case "table":
      return renderTable(node, columns);
    case "card":
      return (
        <Box flexDirection="column">
          {node.title !== undefined && (
            <Text bold color={color("accent")}>
              {truncate(node.title, available)}
            </Text>
          )}
          {node.subtitle !== undefined && <Text color={color("muted")}>{truncate(node.subtitle, available)}</Text>}
          {(() => {
            const labelWidth = Math.min(16, Math.max(0, ...node.fields.map((f) => f.label.length)));
            return node.fields.map((f, i) => (
              <Text key={i}>
                <Text color={color("muted")}>{padCell(f.label, labelWidth, "left")}</Text>
                {" ".repeat(GAP)}
                <Text {...colorProps(toneRole(f.tone))}>{truncate(f.value, available - labelWidth - GAP)}</Text>
              </Text>
            ));
          })()}
          {node.badges !== undefined && node.badges.length > 0 && renderBadgeRow(node.badges)}
        </Box>
      );
    case "stack":
      return (
        <Box flexDirection="column">
          {node.children.map((child, i) => (
            <Box key={i} {...(node.gap === 1 && i > 0 ? { marginTop: 1 } : {})}>
              {renderNode(child, columns)}
            </Box>
          ))}
        </Box>
      );
  }
}
