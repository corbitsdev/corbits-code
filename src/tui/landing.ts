/**
 * The landing screen: what a session looks like before it has said anything.
 *
 * Three parts, split across the prompt box so the box lands in the vertical
 * middle of the terminal:
 *
 *   above   the animated dither mark, bottom-left of its zone, with the two
 *           way-in keys set beside its shoulder
 *   ────    the prompt box and its hint row (owned by the shell)
 *   below   the telemetry disclosure, then a few selectable starter prompts
 *
 * The mark is the screen. Beside it sit exactly two lines — `/` for commands
 * and `/yolo` so permission prompts are not required — because those two are
 * the only doors an operator needs on a screen where nothing has happened yet;
 * every other key is behind one of them, and listing keys here would trade the
 * one legible thing on the screen for a reference card nobody reads twice.
 *
 * The disclosure sits directly under the box rather than at the bottom edge
 * because it has to be read, not discovered.
 *
 * Layout math is pure (`splitLandingRows`, `resolveMarkGrid`, `wrapLanding`) so
 * the composition is testable without a renderer, and the mark repaints off an
 * injected clock.
 */

import { StyledText, fg as fgChunk, type CliRenderer, type TextChunk } from "@opentui/core";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import pkg from "../../package.json" with { type: "json" };

import { MARK_LARGE, MARK_MID, MARK_SMALL, type MarkGrid } from "./mark-shape.js";
import { renderMark } from "./mark-anim.js";
import { UI } from "./theme.js";
import { stringWidth } from "./view/height.js";

/**
 * Left gutter inside the shell's side margin (`resolveSideMargin`, applied to
 * the shell root). One column, matching the transcript's own gutter, so the
 * landing and the first transcript row share a left edge.
 */
export const LANDING_MARGIN = 1;

/** One blank row between the mark and the prompt box. */
const MARK_GAP_ROWS = 1;

/** Columns of air between the mark's right edge and the hint block. */
export const LANDING_HERO_GAP = 3;

/**
 * The running build, read from `package.json` so it cannot drift from what
 * shipped. Rendered in the shell's persistent chrome (bottom-right of the
 * terminal), not as part of this module's landing composition — see
 * `versionBadgeVisible` and `shell.ts`'s `versionBadge`.
 */
export const LANDING_VERSION = `v${pkg.version}`;

/**
 * Minimum terminal size the version badge needs before it hides. 16 rows is
 * above `IDLE_TRANSCRIPT_FLOOR` (12) — the only row floor real chrome is
 * actually held to at rest — so the badge is gone well before the
 * transcript itself would be squeezed. It is also below
 * `BOTTOM_MARGIN_MIN_ROWS` (24): the bottom pad is optical room carved from
 * the transcript residual, not a second reserved chrome row, so the badge's
 * own threshold does not need to clear it.
 */
export const VERSION_BADGE_MIN_COLUMNS = 60;
export const VERSION_BADGE_MIN_ROWS = 16;

export function versionBadgeVisible(columns: number, rows: number): boolean {
  return columns >= VERSION_BADGE_MIN_COLUMNS && rows >= VERSION_BADGE_MIN_ROWS;
}

/**
 * The two doors off the landing screen. `/help` is among the commands `/`
 * opens; `/yolo` is the other way in, so permission prompts do not have to be
 * discovered the hard way.
 */
export const LANDING_HINTS: readonly {
  readonly key: string;
  readonly rest: string;
}[] = [
  { key: "/", rest: "for commands" },
  // One character shorter than the spoken line ("does not") so an 80-column
  // terminal still seats the compact mark beside the aligned descriptions.
  { key: "/yolo", rest: "so Corbits Code doesn't have to ask for permissions" },
];

/**
 * Columns held for the key, so the descriptions beside them start on one
 * column. Ragged, the pair reads as two unrelated lines rather than as a set.
 */
export const LANDING_KEY_WIDTH = LANDING_HINTS.reduce(
  (widest, hint) => Math.max(widest, hint.key.length),
  0,
);

/** Air between the key column and the description it labels. */
const LANDING_KEY_GAP = 2;

/** Columns the hint block needs, its longest line deciding. */
export const LANDING_HINT_WIDTH = LANDING_HINTS.reduce(
  (widest, hint) => Math.max(widest, LANDING_KEY_WIDTH + LANDING_KEY_GAP + hint.rest.length),
  0,
);

/** Largest first: the landing takes the best-reading mark its zone can seat. */
const MARK_TIERS: readonly MarkGrid[] = [MARK_LARGE, MARK_MID, MARK_SMALL];

/**
 * The mark grid that fits the zone above the prompt box, or null when even the
 * compact grid would push the box off screen.
 *
 * Rows are the binding constraint on a short terminal and columns on a narrow
 * one, so both are checked: the mark degrades through the tiers and then
 * disappears, and the prompt box never moves to make room for it.
 */
export function resolveMarkGrid(aboveRows: number, columns: number): MarkGrid | null {
  const width = Math.max(0, columns) - LANDING_MARGIN;
  for (const grid of MARK_TIERS) {
    if (grid.rows + MARK_GAP_ROWS > aboveRows) continue;
    if (grid.cols + LANDING_HERO_GAP + LANDING_HINT_WIDTH > width) continue;
    return grid;
  }
  return null;
}

export interface LandingSuggestion {
  /** The key that fills the prompt with this prompt. */
  readonly key: string;
  readonly label: string;
  /** Text dropped into the prompt verbatim. */
  readonly prompt: string;
}

/**
 * Starter prompts, not decoration: each one is a real first move on an
 * unfamiliar repository, and each is worded as a prompt we would send as-is.
 */
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

/** The suggestion a keypress selects, or null when the key selects nothing. */
export function landingSuggestionFor(key: string): LandingSuggestion | null {
  return LANDING_SUGGESTIONS.find((item) => item.key === key) ?? null;
}

/**
 * Split the transcript zone into the rows above the prompt box and the rows
 * below it, placing the box's middle row on the terminal's middle row.
 *
 * The shell's landing frame is transcript + model bar + 3 prompt rows + hint,
 * so an even split of the transcript zone is what centres the box.
 */
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

/**
 * Choose what fits below the prompt box. The disclosure outranks the
 * suggestions: on a short terminal the starters go, the notice stays.
 */
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
  // One leading blank row, then the notice; the starters add a separating blank
  // row, a header, and one row each.
  const noticeRows = 1 + notice.length;
  const starterRows = (notice.length === 0 ? 0 : 1) + 1 + LANDING_SUGGESTIONS.length;
  const suggestions = input.rows >= noticeRows + starterRows ? LANDING_SUGGESTIONS : [];
  return { notice, suggestions };
}

const SUGGESTION_HEADER = "try";

/**
 * Text rows painted below the prompt box, top to bottom.
 *
 * `suggestionsVisible` is false once the operator has typed anything. The
 * starters are whole-prompt replacements — `applyLandingSuggestion` already
 * refuses to overwrite typed text — so leaving a numbered list on screen would
 * advertise keys that do nothing, and the digits would land in the prompt
 * instead. Offering different, "complementary" text while someone is mid-
 * sentence would be worse still: it competes with the thing being typed. So
 * the starters withdraw and come back the moment the prompt is empty again.
 * The rows stay, blank, so the layout does not jump on the first keystroke.
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
 * The mark, bottom-anchored in its zone so it sits directly on the prompt box
 * rather than floating in the middle of the empty space above it, with the
 * hint block beside its shoulder.
 *
 * Rows are allocated for the largest tier once and hidden from the top down as
 * smaller tiers are selected, so a resize never rebuilds the subtree.
 */
export function createLandingAbove(ctx: CliRenderer, reducedMotion = false): LandingAbove {
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
    // Centred against the mark's full height rather than sitting at its peak:
    // top-aligned, the two lines float beside the summit with the whole slope
    // empty beneath them, which reads as unfinished rather than composed.
    justifyContent: "center",
    paddingLeft: LANDING_HERO_GAP,
    backgroundColor: UI.ground,
  });
  LANDING_HINTS.forEach((hint, index) => {
    const gap = " ".repeat(LANDING_KEY_WIDTH - hint.key.length + LANDING_KEY_GAP);
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

/**
 * Seat the mark in `grid`, or suppress it entirely when `grid` is null. The
 * hint block stays either way: it is the way off the screen, not decoration.
 */
export function fitLandingMark(above: LandingAbove, grid: MarkGrid | null): void {
  above.grid = grid;
  // With no mark, the hero is exactly the hint block: one row per door.
  const rows = grid?.rows ?? LANDING_HINTS.length;
  above.hero.height = rows;
  above.markColumn.visible = grid !== null;
  above.markColumn.width = grid?.cols ?? 0;
  // Extra rows are hidden from the top so the ridgeline keeps its floor.
  above.markRows.forEach((line, index) => {
    line.visible = grid !== null && index >= MARK_LARGE.rows - grid.rows;
  });
}

/**
 * Repaint the mark for the given clock. `still` holds the mountain's
 * draw/fill/fade timeline on its fully-filled frame — the idle state.
 * `reducedMotion` is the separate hook that suppresses snow; it does not
 * affect `still`'s mountain framing.
 */
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

export function createLandingBelow(ctx: CliRenderer, content: LandingBelowContent): BoxRenderable {
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
