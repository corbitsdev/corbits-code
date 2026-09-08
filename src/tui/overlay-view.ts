import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { middleEllipsis } from "./command-display.js";
import { formatPaletteRows, type PaletteCommand } from "./command-catalog.js";
import { visibleSlice, type ListViewportState } from "./list-viewport.js";
import {
  decisionChoiceRows,
  decisionChoiceRowCount,
  describeZoneLines,
  DESCRIPTION_ZONE_LINES,
} from "./overlay-body.js";
import type { ItemDescription, OpenListOverlayOpts, PrimaryOverlayKind } from "./shell.js";
import { destroySubtree } from "./teardown.js";
import { UI } from "./theme.js";

export interface OverlayTitlePresentation extends Pick<
  OpenListOverlayOpts,
  "addProviderHint" | "setDefaultHint" | "mcpManageHint" | "mcpAddHint"
> {
  readonly title: string;
  readonly kind: PrimaryOverlayKind | null;
  readonly hasChoices: boolean;
  readonly answer: { readonly active: boolean } | null;
}

export interface OverlayListPresentation {
  readonly kind: PrimaryOverlayKind | null;
  readonly items: readonly string[];
  readonly paletteCommands: readonly Pick<PaletteCommand, "label">[];
  readonly viewport: ListViewportState | null;
  readonly bodyLines: readonly string[];
  readonly bodyFgs: readonly string[];
  readonly answer: { readonly text: string; readonly active: boolean } | null;
  /** Resolved after rows paint; undefined means no zone, null means an empty zone. */
  readonly describe: () => ItemDescription | null | undefined;
}

/**
 * Rows the overlay host spends on itself before any list row: the bordered box
 * costs a top and bottom rule, plus the title line and the wrapped body lines.
 * Omitting the border here hands the list two rows the host cannot render, and
 * flex then stacks the surplus rows onto cells the prompt border already owns.
 */
export const OVERLAY_HOST_BORDER_ROWS = 2;

/** Rule row plus the fixed two content lines — charged whenever `describe` is set. */
const DESCRIPTION_ZONE_ROWS = 1 + DESCRIPTION_ZONE_LINES;

/** Columns a body/choice row may paint into, inside border and leading space. */
export function overlayRowWidth(contentWidth: number): number {
  return Math.max(8, Math.max(20, contentWidth) - 4);
}

/** Interior columns of the overlay box, inside its border. */
function overlayInteriorWidth(contentWidth: number): number {
  return overlayRowWidth(contentWidth) + 2;
}

/**
 * Overlays that ask a human to authorize something. They get the shaped,
 * spaced treatment from overlay-body.ts; every other list overlay stays a
 * plain one-row-per-item list.
 */
export function isDecisionOverlay(kind: PrimaryOverlayKind | null): boolean {
  return kind === "permissions" || kind === "operator";
}

/** Display rows one list item occupies for the open overlay. */
export function overlayRowsPerItem(
  kind: PrimaryOverlayKind | null,
  items: readonly string[],
  contentWidth: number,
): number {
  if (!isDecisionOverlay(kind)) return 1;
  return decisionChoiceRowCount(items, overlayRowWidth(contentWidth));
}

/**
 * Every other list overlay spends a row on a title rule (`─ permission ─...`);
 * the palette drops it — the box already reads as the palette, and the filter
 * row underneath says what's typed, so the rule was a second header for the
 * same fact.
 */
export function overlayTitleRows(kind: PrimaryOverlayKind | null): number {
  return kind === "palette" ? 0 : 1;
}

export function overlayChromeRows(
  kind: PrimaryOverlayKind | null,
  bodyLineCount: number,
  hasDescription: boolean,
  hasAnswer: boolean,
): number {
  return (
    OVERLAY_HOST_BORDER_ROWS +
    overlayTitleRows(kind) +
    bodyLineCount +
    (hasDescription ? DESCRIPTION_ZONE_ROWS : 0) +
    (hasAnswer ? 1 : 0)
  );
}

/**
 * Smallest host rows the open overlay can render into without spilling past
 * its own box: fixed chrome (border, title, body lines) plus one row of the
 * list when it has anything to show. Below this the resolver must give ground
 * elsewhere (transcript floor) rather than starve the overlay itself.
 */
export function overlayMinHostRows(chromeRows: number, perItem: number, hasItems: boolean): number {
  return chromeRows + (hasItems ? perItem : 0);
}

/**
 * Title row for the overlay host, fitted to the box interior. The title
 * renderable is one row in the host's chrome budget, so a line that wrapped at
 * a narrow width would spend a row nothing accounted for.
 */
function overlayTitleLine(
  title: string,
  interior: number,
  hints: readonly string[] = DEFAULT_OVERLAY_HINTS,
): string {
  const trimmed = title.trim();
  // Empty/blank title: paint hints alone — no leading " · " from a missing title.
  if (trimmed.length === 0) {
    for (const hint of hints) {
      const line = ` ${hint}`;
      if (line.length <= interior) return line;
    }
    return " ";
  }
  const suffixes = [...hints.map((h) => ` · ${h}`), ""];
  for (const suffix of suffixes) {
    const line = ` ${trimmed}${suffix}`;
    if (line.length <= interior) return line;
  }
  return ` ${middleEllipsis(trimmed, Math.max(1, interior - 1))}`;
}

const DEFAULT_OVERLAY_HINTS = ["Esc cancel · Enter choose", "Esc · Enter"] as const;

/** Model picker only: same three-tier fallback shape as DEFAULT_OVERLAY_HINTS. */
const MODEL_PICKER_HINTS = [
  "Esc cancel · Enter choose · Alt+A /connect add provider",
  "Esc · Enter · Alt+A /connect",
  "Esc · Enter",
] as const;

/** Permissions only: name `/yolo` so skip-prompts is discoverable at the ask. */
const PERMISSIONS_HINTS = [
  "Esc cancel · Enter choose · /yolo skip prompts",
  "Esc · Enter · /yolo",
  "Esc · Enter",
] as const;

/** /plugins: longest-first how-to, same fallback shape as the model picker. */
const PLUGINS_HINTS = [
  "Esc cancel · Enter toggle · Alt+A add path · Alt+X remove",
  "Esc · Enter · Alt+A add · Alt+X remove",
  "Esc · Enter · Alt+A · Alt+X",
  "Esc · Enter",
] as const;

const MCP_MANAGE_HINTS_WITH_ADD = [
  "Esc cancel · Enter choose · Alt+A add · Alt+D disable · Alt+R remove",
  "Esc · Enter · Alt+A add · Alt+D · Alt+R",
  "Esc · Enter · Alt+A · Alt+D · Alt+R",
  "Esc · Enter",
] as const;

const MCP_MANAGE_HINTS_WITHOUT_ADD = [
  "Esc cancel · Enter choose · Alt+D disable · Alt+R remove",
  "Esc · Enter · Alt+D · Alt+R",
  "Esc · Enter",
] as const;

/**
 * Key hints for the open overlay, longest first — the title line falls back to
 * shorter ones as the terminal narrows.
 *
 * Never promises "Enter choose" when there is nothing to choose: an overlay
 * with no rows says what the operator can actually do instead.
 */
function overlayHints(presentation: OverlayTitlePresentation): readonly string[] {
  const { answer, hasChoices, kind } = presentation;
  if (answer === null) {
    if (!hasChoices) return ["Esc dismiss"];
    if (kind === "model_picker") {
      const addProvider = presentation.addProviderHint;
      const setDefault = presentation.setDefaultHint;
      if (addProvider && setDefault) {
        return [
          "Esc cancel · Enter choose · Alt+A /connect add provider · Alt+D set default",
          "Esc · Enter · Alt+A /connect · Alt+D default",
          "Esc · Enter · Alt+A · Alt+D",
          "Esc · Enter",
        ];
      }
      if (addProvider) return MODEL_PICKER_HINTS;
      if (setDefault) {
        return [
          "Esc cancel · Enter choose · Alt+D set default",
          "Esc · Enter · Alt+D default",
          "Esc · Enter",
        ];
      }
    }
    if (kind === "permissions") return PERMISSIONS_HINTS;
    if (kind === "plugins") return PLUGINS_HINTS;
    if (kind === "mcp" && presentation.mcpManageHint) {
      return presentation.mcpAddHint ? MCP_MANAGE_HINTS_WITH_ADD : MCP_MANAGE_HINTS_WITHOUT_ADD;
    }
    return DEFAULT_OVERLAY_HINTS;
  }
  if (answer.active) {
    return hasChoices
      ? ["Esc back to choices · Enter send", "Esc back · Enter send"]
      : ["Esc cancel · Enter send", "Esc · Enter"];
  }
  return [
    "Esc cancel · Enter choose · Tab type an answer",
    "Esc · Enter · Tab type",
    "Esc · Enter",
  ];
}

/** Cursor cell shown at the end of the answer field while it has the keys. */
const ANSWER_CURSOR = "▌";

export function createOverlayView(ctx: RenderContext) {
  const host = new BoxRenderable(ctx, {
    id: "shell-overlay-host",
    width: "100%",
    height: 1,
    flexShrink: 0,
    flexDirection: "column",
    // A short terminal can leave the host fewer rows than its body wants. Rows
    // that do not fit are clipped rather than painted over the chrome below,
    // which would leave a half-overlay the operator cannot dismiss.
    overflow: "hidden",
    border: true,
    borderColor: UI.textDim,
    backgroundColor: UI.ground,
    visible: false,
  });
  const title = new TextRenderable(ctx, {
    id: "shell-overlay-title",
    content: " overlay",
    fg: UI.textDim,
  });
  const body = new BoxRenderable(ctx, {
    id: "shell-overlay-body",
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: UI.ground,
  });
  host.add(title);
  host.add(body);

  function clearBody(): void {
    const kids = [...body.getChildren()];
    for (const child of kids) {
      body.remove(child);
      destroySubtree(child);
    }
  }

  function addOverlayRow(content: string, fg: string): void {
    body.add(
      new TextRenderable(ctx, {
        content,
        fg,
        height: 1,
        // Without this, a body taller than its host makes flex shrink every row
        // toward zero and paint several of them into the same terminal cells.
        flexShrink: 0,
      }),
    );
  }

  /**
   * Selection is a text colour, not a marker or a filled band: the highlighted
   * row already stands out by sitting under the cursor, so a leading `>` and a
   * grey block would both be saying the same thing twice.
   */
  function paintPaletteList(
    commands: OverlayListPresentation["paletteCommands"],
    list: ListViewportState,
    contentWidth: number,
  ): void {
    const interior = overlayInteriorWidth(contentWidth);
    const lines = formatPaletteRows(
      commands.map((command) => command.label),
      Math.max(4, interior - 1),
    );
    const slice = visibleSlice(list);
    for (let i = slice.start; i < slice.end; i++) {
      const line = lines[i] ?? "";
      const active = i === list.activeIndex;
      const content = ` ${line}`.padEnd(interior);
      addOverlayRow(content, active ? UI.text : UI.textDim);
    }
  }

  /** Paint the fixed rule + two-line description zone under the list, when `describe` is set. */
  function paintDescriptionZone(
    describe: OverlayListPresentation["describe"],
    contentWidth: number,
  ): void {
    const width = overlayRowWidth(contentWidth);
    const desc = describe();
    if (desc === undefined) return;
    addOverlayRow(` ${"─".repeat(Math.max(0, width))}`, UI.textFaint);
    const { lines, fgs } = describeZoneLines(desc, width);
    lines.forEach((line, i) => {
      addOverlayRow(line.length > 0 ? ` ${line}` : "", fgs[i] ?? UI.textFaint);
    });
  }

  /**
   * Paint the free-text answer field, when the open overlay offers one. Always
   * on screen so "you may type instead of picking" is visible rather than folk
   * knowledge; dim and labelled with its key until it is taking keystrokes.
   */
  function paintAnswerRow(answer: OverlayListPresentation["answer"], contentWidth: number): void {
    if (answer === null) return;
    const width = overlayRowWidth(contentWidth);
    if (!answer.active) {
      addOverlayRow(` Tab  type your own answer`, UI.textDim);
      return;
    }
    const label = "answer> ";
    const room = Math.max(1, width - label.length - ANSWER_CURSOR.length);
    const tail = answer.text.length > room ? answer.text.slice(-room) : answer.text;
    addOverlayRow(` ${label}${tail}${ANSWER_CURSOR}`, UI.text);
  }

  function paintList(presentation: OverlayListPresentation, contentWidth: number): void {
    const list = presentation.viewport;
    clearBody();
    if (!list) return;
    presentation.bodyLines.forEach((line, i) => {
      addOverlayRow(` ${line}`, presentation.bodyFgs[i] ?? UI.text);
    });
    if (presentation.kind === "palette" && presentation.paletteCommands.length > 0) {
      paintPaletteList(presentation.paletteCommands, list, contentWidth);
      paintDescriptionZone(presentation.describe, contentWidth);
      return;
    }
    const decision = isDecisionOverlay(presentation.kind);
    const width = overlayRowWidth(contentWidth);
    const perItem = overlayRowsPerItem(presentation.kind, presentation.items, contentWidth);
    const slice = visibleSlice(list);
    for (let i = slice.start; i < slice.end; i++) {
      const label = presentation.items[i] ?? `item ${i}`;
      const active = i === list.activeIndex;
      if (!decision) {
        addOverlayRow(` ${active ? ">" : " "} ${label}`, active ? UI.text : UI.textDim);
        continue;
      }
      for (const row of decisionChoiceRows(label, active, width, perItem)) {
        addOverlayRow(` ${row.text}`, row.fg);
      }
    }
    paintAnswerRow(presentation.answer, contentWidth);
    paintDescriptionZone(presentation.describe, contentWidth);
  }

  function paintTitle(presentation: OverlayTitlePresentation, contentWidth: number): void {
    title.visible = true;
    title.content = overlayTitleLine(
      presentation.title,
      overlayInteriorWidth(contentWidth),
      overlayHints(presentation),
    );
  }

  return { host, title, body, paintTitle, paintList, clearBody };
}
