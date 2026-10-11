/**
 * The landing screen: the mark above the prompt box, the telemetry
 * disclosure and starter prompts below, split so the box lands mid-terminal.
 * Pure layout math keeps it testable without a renderer; the mark repaints
 * off an injected clock.
 */

import {
  StyledText,
  fg as fgChunk,
  type CliRenderer,
  type TextChunk,
} from "@opentui/core";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import pkg from "../../package.json" with { type: "json" };

import {
  MARK_LARGE,
  MARK_MID,
  MARK_SMALL,
  type MarkGrid,
} from "./mark-shape.js";
import { renderMark } from "./mark-anim.js";
import { UI } from "./theme.js";
import { stringWidth } from "./view/height.js";

/** One-column left gutter matching the transcript so both share a left
 * edge. */
export const LANDING_MARGIN = 1;

/** One blank row between the mark and the prompt box. */
const MARK_GAP_ROWS = 1;

/** Columns of air between the mark's right edge and the hint block. */
export const LANDING_HERO_GAP = 3;

/** The running build, read from `package.json` so it cannot drift;
 * rendered in the persistent chrome, not here. */
export const LANDING_VERSION = `v${pkg.version}`;

/** Minimum size for the version badge: below it, the badge hides before
 * the transcript is squeezed. */
export const VERSION_BADGE_MIN_COLUMNS = 60;
export const VERSION_BADGE_MIN_ROWS = 16;

export function versionBadgeVisible(columns: number, rows: number): boolean {
  return columns >= VERSION_BADGE_MIN_COLUMNS && rows >= VERSION_BADGE_MIN_ROWS;
}

/** The two doors off the landing: `/` for commands, `/yolo` for
 * permission-free runs. */
export const LANDING_HINTS: readonly {
  readonly key: string;
  readonly rest: string;
}[] = [
  { key: "/", rest: "for commands" },
  // "doesn't" is one char shorter, so 80 columns still seat the compact mark.
  { key: "/yolo", rest: "so Corbits Code doesn't have to ask for permissions" },
];

/** Key-column width so both descriptions start on one column. */
export const LANDING_KEY_WIDTH = LANDING_HINTS.reduce(
  (widest, hint) => Math.max(widest, hint.key.length),
  0,
);

/** Air between the key column and the description it labels. */
const LANDING_KEY_GAP = 2;

/** Columns the hint block needs, its longest line deciding. */
export const LANDING_HINT_WIDTH = LANDING_HINTS.reduce(
  (widest, hint) =>
    Math.max(widest, LANDING_KEY_WIDTH + LANDING_KEY_GAP + hint.rest.length),
  0,
);

/** Largest first: the landing takes the best-reading mark its zone can seat. */
const MARK_TIERS: readonly MarkGrid[] = [MARK_LARGE, MARK_MID, MARK_SMALL];

/**
 * The largest mark grid that fits above the prompt box, or null. Rows bind
 * on short terminals, columns on narrow ones; the prompt box never moves
 * for the mark.
 */
export function resolveMarkGrid(
  aboveRows: number,
  columns: number,
): MarkGrid | null {
  const width = Math.max(0, columns) - LANDING_MARGIN;
  for (const grid of MARK_TIERS) {
    if (grid.rows + MARK_GAP_ROWS > aboveRows) continue;
    if (grid.cols + LANDING_HERO_GAP + LANDING_HINT_WIDTH > width) continue;
    return grid;
  }
  return null;
}

export interface LandingSuggestion {
  /** Key that fills the prompt with this starter's text. */
  readonly key: string;
  readonly label: string;
  /** Text dropped into the prompt verbatim. */
  readonly prompt: string;
}

/** Starter prompts: first moves on an unfamiliar repo, worded as we
 * would send them. */
export const LANDING_SUGGESTIONS: readonly LandingSuggestion[] = [
  {
    key: "1",
    label: "explain this codebase",
    prompt:
      "Explain what this project does and how it is structured. Start from the entry points and the docs.",
  },
  {
    key: "2",
    label: "find and fix a failing test",
    prompt:
      "Run the test suite, pick the first failing test, explain why it fails, and fix the cause rather than the assertion.",
  },
  {
    key: "3",
    label: "review my uncommitted changes",
    prompt:
      "Review my uncommitted changes for correctness, missing tests, and anything that does not match the conventions in this repo.",
  },
];

/** The suggestion a key selects, or null. */
export function landingSuggestionFor(key: string): LandingSuggestion | null {
  return LANDING_SUGGESTIONS.find((item) => item.key === key) ?? null;
}

/** Even split so the box's middle row sits mid-terminal; the frame is
 * transcript + model bar + 3 prompt rows + hint. */
export function splitLandingRows(transcriptRows: number): {
  readonly above: number;
  readonly below: number;
} {
  const total = Math.max(0, transcriptRows);
  const above = Math.floor(total / 2);
  return { above, below: total - above };
}

/** Greedy word wrap. Long words are left over-long rather than broken. */
export function wrapLanding(text: string, width: number): readonly string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (stringWidth(candidate) <= width) {
      line = candidate;
      continue;
    }
    if (line.length > 0) lines.push(line);
    line = word;
  }
  if (line.length > 0) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

export interface LandingBelowContent {
  readonly notice: readonly string[];
  readonly suggestions: readonly LandingSuggestion[];
}

/** What fits below the prompt box: the disclosure outranks the starters. */
export function landingBelowContent(input: {
  readonly rows: number;
  /** Content width already inside the shell's side margin. */
  readonly columns: number;
  readonly telemetryNotice?: string | undefined;
}): LandingBelowContent {
  const width = Math.max(1, input.columns - LANDING_MARGIN);
  const notice =
    input.telemetryNotice === undefined || input.telemetryNotice.length === 0
      ? []
      : wrapLanding(input.telemetryNotice, width);
  // Notice rows: one blank plus the text; starters add a blank, a header,
  // and one row each.
  const noticeRows = 1 + notice.length;
  const starterRows =
    (notice.length === 0 ? 0 : 1) + 1 + LANDING_SUGGESTIONS.length;
  const suggestions =
    input.rows >= noticeRows + starterRows ? LANDING_SUGGESTIONS : [];
  return { notice, suggestions };
}

const SUGGESTION_HEADER = "try";

/**
 * Rows below the prompt box. Once the operator has typed they stay blank:
 * the starters are whole-prompt replacements, and blank rows keep the layout
 * from jumping on the first keystroke.
 */
export function landingBelowRows(
  content: LandingBelowContent,
  suggestionsVisible = true,
): readonly {
  readonly text: string;
  readonly fg: string;
}[] {
  const rows: { text: string; fg: string }[] = [{ text: "", fg: UI.textDim }];
  for (const line of content.notice) rows.push({ text: line, fg: UI.textDim });
  if (content.suggestions.length > 0) {
    if (content.notice.length > 0) rows.push({ text: "", fg: UI.textDim });
    rows.push({
      text: suggestionsVisible ? SUGGESTION_HEADER : "",
      fg: UI.textFaint,
    });
    for (const item of content.suggestions) {
      rows.push({
        text: suggestionsVisible ? `${item.key}  ${item.label}` : "",
        fg: UI.textDim,
      });
    }
  }
  return rows;
}

function markChunks(
  grid: MarkGrid,
  nowMs: number,
  still: boolean,
  reducedMotion = false,
): readonly TextChunk[][] {
  return renderMark({ nowMs, still, grid, reducedMotion }).map((row) =>
    row.map((cell) => fgChunk(cell.fg)(cell.char)),
  );
}

export interface LandingAbove {
  readonly box: BoxRenderable;
  readonly hero: BoxRenderable;
  readonly markColumn: BoxRenderable;
  readonly markRows: readonly TextRenderable[];
  /** The grid currently painted, or null while the mark is suppressed. */
  grid: MarkGrid | null;
}

/**
 * The mark bottom-anchored to the prompt box, the hint block beside its
 * shoulder. Rows are allocated for the largest tier once and hidden from the
 * top, so a resize never rebuilds the subtree.
 */
export function createLandingAbove(
  ctx: CliRenderer,
  reducedMotion = false,
): LandingAbove {
  const box = new BoxRenderable(ctx, {
    id: "shell-landing-above",
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    justifyContent: "flex-end",
    paddingLeft: LANDING_MARGIN,
    backgroundColor: UI.ground,
  });
  const hero = new BoxRenderable(ctx, {
    id: "shell-landing-hero",
    width: "100%",
    height: MARK_LARGE.rows,
    flexShrink: 0,
    flexDirection: "row",
    backgroundColor: UI.ground,
  });
  const markColumn = new BoxRenderable(ctx, {
    id: "shell-landing-mark",
    width: MARK_LARGE.cols,
    flexShrink: 0,
    flexDirection: "column",
    justifyContent: "flex-end",
    backgroundColor: UI.ground,
  });
  const markRows: TextRenderable[] = [];
  for (let row = 0; row < MARK_LARGE.rows; row++) {
    const line = new TextRenderable(ctx, {
      id: `shell-landing-mark-${row}`,
      height: 1,
      content: "",
      fg: UI.action,
    });
    markRows.push(line);
    markColumn.add(line);
  }
  hero.add(markColumn);
  hero.add(createHintBlock(ctx));
  box.add(hero);
  box.add(
    new TextRenderable(ctx, {
      id: "shell-landing-mark-gap",
      height: MARK_GAP_ROWS,
      content: "",
      fg: UI.ground,
    }),
  );
  const above: LandingAbove = {
    box,
    hero,
    markColumn,
    markRows,
    grid: MARK_SMALL,
  };
  fitLandingMark(above, MARK_SMALL);
  paintLandingMark(above, 0, true, reducedMotion);
  return above;
}

/** The two doors, key emphasized and the rest dim. */
function createHintBlock(ctx: CliRenderer): BoxRenderable {
  const block = new BoxRenderable(ctx, {
    id: "shell-landing-hints",
    flexGrow: 1,
    flexDirection: "column",
    // Centred against the mark's full height; against the peak they read
    // unfinished.
    justifyContent: "center",
    paddingLeft: LANDING_HERO_GAP,
    backgroundColor: UI.ground,
  });
  LANDING_HINTS.forEach((hint, index) => {
    const gap = " ".repeat(
      LANDING_KEY_WIDTH - hint.key.length + LANDING_KEY_GAP,
    );
    block.add(
      new TextRenderable(ctx, {
        id: `shell-landing-hint-${index}`,
        height: 1,
        content: new StyledText([
          fgChunk(UI.text)(hint.key),
          fgChunk(UI.textDim)(`${gap}${hint.rest}`),
        ]),
      }),
    );
  });
  return block;
}

/** Seat the mark in `grid`, or suppress it when null. The hints stay:
 * they are the way off the screen. */
export function fitLandingMark(
  above: LandingAbove,
  grid: MarkGrid | null,
): void {
  above.grid = grid;
  // No mark: the hero is just the hint block, one row per door.
  const rows = grid?.rows ?? LANDING_HINTS.length;
  above.hero.height = rows;
  above.markColumn.visible = grid !== null;
  above.markColumn.width = grid?.cols ?? 0;
  // Hidden from the top so the ridgeline keeps its floor.
  above.markRows.forEach((line, index) => {
    line.visible = grid !== null && index >= MARK_LARGE.rows - grid.rows;
  });
}

/** Repaint the mark for the clock. `still` freezes the draw/fill/fade
 * timeline on its filled frame; `reducedMotion` suppresses snow only. */
export function paintLandingMark(
  above: LandingAbove,
  nowMs: number,
  still: boolean,
  reducedMotion = false,
): void {
  const grid = above.grid;
  if (grid === null) return;
  const chunks = markChunks(grid, nowMs, still, reducedMotion);
  const offset = MARK_LARGE.rows - grid.rows;
  above.markRows.forEach((line, index) => {
    const row = chunks[index - offset];
    if (row !== undefined) line.content = new StyledText([...row]);
  });
}

export function createLandingBelow(
  ctx: CliRenderer,
  content: LandingBelowContent,
): BoxRenderable {
  const box = new BoxRenderable(ctx, {
    id: "shell-landing-below",
    width: "100%",
    flexShrink: 0,
    flexDirection: "column",
    paddingLeft: LANDING_MARGIN,
    backgroundColor: UI.ground,
  });
  landingBelowRows(content).forEach((row, index) => {
    box.add(
      new TextRenderable(ctx, {
        id: `shell-landing-below-${index}`,
        height: 1,
        content: row.text,
        fg: row.fg,
      }),
    );
  });
  return box;
}

/** Repaint the rows below the box for the current suggestion visibility. */
export function paintLandingBelow(
  box: BoxRenderable,
  content: LandingBelowContent,
  suggestionsVisible: boolean,
): void {
  const rows = landingBelowRows(content, suggestionsVisible);
  box.getChildren().forEach((child, index) => {
    const row = rows[index];
    if (row !== undefined && child instanceof TextRenderable) {
      child.content = row.text;
    }
  });
}
