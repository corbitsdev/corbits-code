/**
 * The prompt box's border, and the metadata it carries.
 *
 * The box has no bars above or below it: the model name rides the top rule and
 * the workspace (directory + git branch) rides the bottom one, so both cost
 * zero rows. The rule breaks around each label and resumes on the far side,
 * which is what makes the label read as part of the frame rather than as text
 * that happens to sit on it.
 *
 * Pure: text in, ordered parts out. The shell colours the parts and swaps the
 * `brand` part for the animated lockup cells, which is why a placeholder of the
 * lockup's exact width is passed in rather than the cells themselves.
 */

import { stringWidth } from "./view/height.js";
import { formatContextPercentLabel } from "../cost/cost-summary.js";
import { contextMeterBand, type ContextMeterBand } from "../provider/context-window.js";

/** Rounded box drawing, all single-cell. */
export const BORDER = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
} as const;

/**
 * `rule` is frame, `label` is metadata, `brand` is the lockup's reserved run,
 * `meter` is the cost/context run. The shell paints each role differently;
 * nothing else distinguishes them.
 */
export type RuleRole = "rule" | "label" | "brand" | "meter" | "attention";

export interface RulePart {
  readonly text: string;
  readonly role: RuleRole;
}

export interface RuleInput {
  readonly width: number;
  readonly corners: readonly [string, string];
  /** Left-hand run (the lockup). Dropped first when the rule cannot seat everything. */
  readonly brand?: string;
  /**
   * Cost/context run, richest form (percent + cost). Sits
   * between the brand and the label. Dropped before the label but after the
   * brand: it is a live gauge, not the operator's own workspace.
   */
  readonly meter?: string;
  /** `meter` with the cost suffix already stripped — tried once `meter` no longer fits. */
  readonly meterCompact?: string;
  /**
   * Compact call-to-action immediately left of the label (e.g. `mcp !`).
   * Dropped after the meter and before the label: it is a standing ask, not
   * the operator's own workspace or model identity.
   */
  readonly attention?: string;
  /** Right-aligned label. Dropped last: it is information, the mark is not. */
  readonly label?: string;
}

/** Rule cells held between a corner and the nearest run, and the minimum flexible fill. */
const RULE_MARGIN = 1;

/** Rule cells held between the meter run and the label. */
const RULE_GAP = 1;

function widthOf(parts: readonly RulePart[]): number {
  let total = 0;
  for (const part of parts) total += stringWidth(part.text);
  return total;
}

function dashes(count: number): string {
  return BORDER.horizontal.repeat(Math.max(0, count));
}

function padCell(text: string): string {
  return text.length > 0 ? ` ${text} ` : "";
}

interface RightBlock {
  readonly parts: readonly RulePart[];
  readonly cost: number;
}

/** Compact standing mark when any MCP server still needs authorization. */
export const MCP_ATTENTION_LABEL = "mcp !";

/** Compact standing mark when plugin load left standing warnings (see `/plugins`). */
export const PLUGIN_ATTENTION_LABEL = "plugin !";

/**
 * Build the single attention slot. MCP and plugin marks share one run so the
 * border never grows a second attention cell — operator-chosen combined form.
 */
export function composeAttentionLabel(opts: {
  readonly mcp?: boolean;
  readonly plugin?: boolean;
}): string | undefined {
  const parts: string[] = [];
  if (opts.mcp === true) parts.push(MCP_ATTENTION_LABEL);
  if (opts.plugin === true) parts.push(PLUGIN_ATTENTION_LABEL);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** The meter, attention mark, and label — in that order, joined by a fixed dash run. */
function buildRightBlock(meterCell: string, attentionCell: string, labelCell: string): RightBlock {
  const cells: readonly { readonly text: string; readonly role: RuleRole }[] = [
    { text: meterCell, role: "meter" },
    { text: attentionCell, role: "attention" },
    { text: labelCell, role: "label" },
  ];
  const parts: RulePart[] = [];
  for (const cell of cells) {
    if (cell.text.length === 0) continue;
    if (parts.length > 0) parts.push({ text: dashes(RULE_GAP), role: "rule" });
    parts.push({ text: cell.text, role: cell.role });
  }
  return { parts, cost: widthOf(parts) };
}

/** Corner, margin, brand, flexible fill, then the right block, margin, corner. */
function layoutWithBrand(
  open: string,
  close: string,
  inner: number,
  brandCell: string,
  brandCost: number,
  block: RightBlock,
): RulePart[] | null {
  if (brandCost === 0 || block.cost === 0) return null;
  if (inner < RULE_MARGIN * 2 + RULE_GAP + brandCost + block.cost) return null;
  const fill = inner - RULE_MARGIN * 2 - brandCost - block.cost;
  return [
    { text: open, role: "rule" },
    { text: dashes(RULE_MARGIN), role: "rule" },
    { text: brandCell, role: "brand" },
    { text: dashes(fill), role: "rule" },
    ...block.parts,
    { text: dashes(RULE_MARGIN), role: "rule" },
    { text: close, role: "rule" },
  ];
}

/** The right block alone, right-aligned: flexible fill on its left, a bare margin on its right. */
function layoutRightOnly(
  open: string,
  close: string,
  inner: number,
  block: RightBlock,
): RulePart[] | null {
  if (block.cost === 0) return null;
  if (inner < RULE_MARGIN * 2 + block.cost) return null;
  const lead = inner - RULE_MARGIN - block.cost;
  return [
    { text: open, role: "rule" },
    { text: dashes(lead), role: "rule" },
    ...block.parts,
    { text: dashes(RULE_MARGIN), role: "rule" },
    { text: close, role: "rule" },
  ];
}

/** The brand alone, left-aligned: a bare margin on its left, flexible fill on its right. */
function layoutBrandOnly(
  open: string,
  close: string,
  inner: number,
  brandCell: string,
  brandCost: number,
): RulePart[] | null {
  if (brandCost === 0) return null;
  if (inner < RULE_MARGIN * 2 + brandCost) return null;
  const trail = inner - RULE_MARGIN - brandCost;
  return [
    { text: open, role: "rule" },
    { text: dashes(RULE_MARGIN), role: "rule" },
    { text: brandCell, role: "brand" },
    { text: dashes(trail), role: "rule" },
    { text: close, role: "rule" },
  ];
}

function plainRule(open: string, close: string, inner: number): RulePart[] {
  return [
    { text: open, role: "rule" },
    { text: dashes(inner), role: "rule" },
    { text: close, role: "rule" },
  ];
}

/**
 * Compose one border rule. Runs are dropped whole, never truncated mid-glyph:
 * a half-written label corrupts the frame, a missing one just reads as a
 * plain rule. Drop order, most to least expendable: brand, then the meter's
 * cost suffix, then the meter's context reading, then the attention mark,
 * then the label — the operator's own workspace path survives everything else.
 */
export function composeRule(input: RuleInput): readonly RulePart[] {
  const width = Math.max(0, Math.floor(input.width));
  const [open, close] = input.corners;
  if (width <= 0) return [];
  if (width <= 2) {
    return [{ text: (open + close).slice(0, width), role: "rule" }];
  }

  const inner = width - 2;
  const brandCell = padCell(input.brand?.trim() ?? "");
  const brandCost = stringWidth(brandCell);
  const labelCell = padCell(input.label?.trim() ?? "");
  const meterFullCell = padCell(input.meter?.trim() ?? "");
  const meterCompactCell = padCell(input.meterCompact?.trim() ?? "");
  const attentionCell = padCell(input.attention?.trim() ?? "");

  const withCost = buildRightBlock(meterFullCell, attentionCell, labelCell);
  const withoutCost = buildRightBlock(meterCompactCell, attentionCell, labelCell);
  const withoutContext = buildRightBlock("", attentionCell, labelCell);
  const withoutAttention = buildRightBlock("", "", labelCell);

  const stages: (() => RulePart[] | null)[] = [
    () => layoutWithBrand(open, close, inner, brandCell, brandCost, withCost),
    () => layoutRightOnly(open, close, inner, withCost),
    () => layoutRightOnly(open, close, inner, withoutCost),
    () => layoutRightOnly(open, close, inner, withoutContext),
    () => layoutRightOnly(open, close, inner, withoutAttention),
    () => layoutBrandOnly(open, close, inner, brandCell, brandCost),
  ];
  for (const stage of stages) {
    const result = stage();
    if (result !== null) return result;
  }
  return plainRule(open, close, inner);
}

/** Flatten a rule to plain text — what the shape tests read. */
export function ruleText(parts: readonly RulePart[]): string {
  return parts.map((part) => part.text).join("");
}

/** True when the composed rule is an unbroken run of frame characters. */
export function isPlainRule(parts: readonly RulePart[]): boolean {
  return parts.every((part) => part.role === "rule");
}

/** Total columns a composed rule occupies. */
export function ruleWidth(parts: readonly RulePart[]): number {
  return widthOf(parts);
}

export interface CostContextInput {
  /** 0–100, or null when the model's context window is unknown. */
  readonly contextPercentUsed: number | null;
  /** Already formatted (e.g. `$0.42`); omitted or empty hides the cost suffix. */
  readonly costLabel?: string | null;
  /** True when `contextPercentUsed` came from the local estimate because the
   * provider omitted or zeroed usage, rather than from reported usage. */
  readonly contextIsEstimate: boolean;
}

export interface CostContextMeter {
  readonly percentLabel: string;
  readonly costLabel: string | null;
  /** Inclusive band from `contextPercentUsed`: 0–60 quiet, 61–80 warning, 81–100 danger. */
  readonly band: ContextMeterBand;
}

/**
 * Resolve the border meter's content from live cost/context state. Null when
 * there is nothing to show — an unknown context window is worse than useless
 * as a percentage, so the run is omitted rather than showing `--%`.
 */
export function composeCostContextMeter(input: CostContextInput): CostContextMeter | null {
  if (input.contextPercentUsed === null) return null;
  const percent = Math.max(0, Math.min(100, Math.round(input.contextPercentUsed)));
  const cost = input.costLabel?.trim() ?? "";
  return {
    percentLabel: formatContextPercentLabel(percent, input.contextIsEstimate),
    costLabel: cost.length > 0 ? cost : null,
    band: contextMeterBand(percent),
  };
}

/**
 * `percent%`, or `percent% · cost` with cost included. A plain reading, not a
 * ramp: the bottom-left slot is where this border moves, and a second animated
 * run competing with it made the rule read as two indicators rather than one.
 */
export function costContextText(meter: CostContextMeter, includeCost: boolean): string {
  const base = meter.percentLabel;
  return includeCost && meter.costLabel !== null ? `${base} · ${meter.costLabel}` : base;
}

export function meterEquals(a: CostContextMeter | null, b: CostContextMeter | null): boolean {
  if (a === null || b === null) return a === b;
  return a.percentLabel === b.percentLabel && a.costLabel === b.costLabel;
}

/** Replace the operator's home directory with `~`. */
export function abbreviateHome(path: string, home: string): string {
  if (home.length === 0) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export interface WorkspaceLabelInput {
  readonly cwd: string;
  readonly branch?: string | null;
  readonly home?: string;
  /** Columns the label may occupy. */
  readonly maxWidth: number;
}

/**
 * `~/abklabs/corbits-code (main)`, shortened from the left so the branch — the
 * part that changes and the part a mistake is expensive in — always survives.
 */
export function composeWorkspaceLabel(input: WorkspaceLabelInput): string {
  const max = Math.max(0, Math.floor(input.maxWidth));
  const branch = input.branch?.trim() ?? "";
  const suffix = branch.length > 0 ? ` (${branch})` : "";
  const path = abbreviateHome(input.cwd.trim(), input.home ?? "");
  if (path.length === 0) return branch.length > 0 ? `(${branch})` : "";

  const full = `${path}${suffix}`;
  if (stringWidth(full) <= max) return full;

  const room = max - stringWidth(suffix);
  const truncated = truncateFromLeft(path, room);
  if (truncated.length > 0) return `${truncated}${suffix}`;
  // The path no longer earns its columns; the branch alone still does.
  const bare = branch.length > 0 ? `(${branch})` : "";
  return stringWidth(bare) <= max ? bare : "";
}

/** Keep the tail of a path, marking the elision with a leading ellipsis. */
function truncateFromLeft(path: string, maxWidth: number): string {
  if (maxWidth <= 1) return "";
  if (stringWidth(path) <= maxWidth) return path;
  const segments = path.split("/");
  for (let start = 1; start < segments.length; start++) {
    const candidate = `…/${segments.slice(start).join("/")}`;
    if (stringWidth(candidate) <= maxWidth) return candidate;
  }
  const tail = segments[segments.length - 1] ?? "";
  const candidate = `…${tail.slice(Math.max(0, tail.length - (maxWidth - 1)))}`;
  return stringWidth(candidate) <= maxWidth ? candidate : "";
}
