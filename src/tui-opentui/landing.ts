/**
 * The landing screen: what a session looks like before it has said anything.
 *
 * Three parts, split across the prompt box so the box lands in the vertical
 * middle of the terminal:
 *
 *   above   the animated dither mark, bottom-left of its zone
 *   ────    the prompt box and its hint row (owned by the shell)
 *   below   the telemetry disclosure, then a few selectable starter prompts
 *
 * The disclosure sits directly under the box rather than at the bottom edge
 * because it has to be read, not discovered.
 *
 * Layout math is pure (`splitLandingRows`, `wrapLanding`) so the composition is
 * testable without a renderer, and the mark repaints off an injected clock.
 */

import {
  StyledText,
  fg as fgChunk,
  type CliRenderer,
  type TextChunk,
} from "@opentui/core"
import { BoxRenderable, TextRenderable } from "@opentui/core"

import { MARK_ROWS } from "./mark-shape.js"
import { renderMark } from "./mark-anim.js"
import { UI } from "./theme.js"

/**
 * Left gutter inside the shell's side margin (`resolveSideMargin`, applied to
 * the shell root). One column, matching the transcript's own gutter, so the
 * landing and the first transcript row share a left edge.
 */
export const LANDING_MARGIN = 1

/** One blank row between the mark and the prompt box. */
const MARK_GAP_ROWS = 1

export type LandingSuggestion = {
  /** The key that fills the prompt with this prompt. */
  readonly key: string
  readonly label: string
  /** Text dropped into the prompt verbatim. */
  readonly prompt: string
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
]

/** The suggestion a keypress selects, or null when the key selects nothing. */
export function landingSuggestionFor(key: string): LandingSuggestion | null {
  return LANDING_SUGGESTIONS.find((item) => item.key === key) ?? null
}

/**
 * Split the transcript zone into the rows above the prompt box and the rows
 * below it, placing the box's middle row on the terminal's middle row.
 *
 * The shell's landing frame is transcript + model bar + 3 prompt rows + hint,
 * so an even split of the transcript zone is what centres the box.
 */
export function splitLandingRows(transcriptRows: number): {
  readonly above: number
  readonly below: number
} {
  const total = Math.max(0, transcriptRows)
  const above = Math.floor(total / 2)
  return { above, below: total - above }
}

/** Greedy word wrap. Long words are left over-long rather than broken. */
export function wrapLanding(text: string, width: number): readonly string[] {
  if (width <= 0) return [text]
  const lines: string[] = []
  let line = ""
  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    const candidate = line.length === 0 ? word : `${line} ${word}`
    if (candidate.length <= width) {
      line = candidate
      continue
    }
    if (line.length > 0) lines.push(line)
    line = word
  }
  if (line.length > 0) lines.push(line)
  return lines.length > 0 ? lines : [""]
}

export type LandingBelowContent = {
  readonly notice: readonly string[]
  readonly suggestions: readonly LandingSuggestion[]
}

/**
 * Choose what fits below the prompt box. The disclosure outranks the
 * suggestions: on a short terminal the starters go, the notice stays.
 */
export function landingBelowContent(input: {
  readonly rows: number
  /** Content width already inside the shell's side margin. */
  readonly columns: number
  readonly telemetryNotice?: string | undefined
}): LandingBelowContent {
  const width = Math.max(1, input.columns - LANDING_MARGIN)
  const notice =
    input.telemetryNotice === undefined || input.telemetryNotice.length === 0
      ? []
      : wrapLanding(input.telemetryNotice, width)
  // One leading blank row, then the notice; the starters add a separating blank
  // row, a header, and one row each.
  const noticeRows = 1 + notice.length
  const starterRows = (notice.length === 0 ? 0 : 1) + 1 + LANDING_SUGGESTIONS.length
  const suggestions =
    input.rows >= noticeRows + starterRows ? LANDING_SUGGESTIONS : []
  return { notice, suggestions }
}

const SUGGESTION_HEADER = "try"

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
  readonly text: string
  readonly fg: string
}[] {
  const rows: { text: string; fg: string }[] = [{ text: "", fg: UI.textDim }]
  for (const line of content.notice) rows.push({ text: line, fg: UI.textDim })
  if (content.suggestions.length > 0) {
    if (content.notice.length > 0) rows.push({ text: "", fg: UI.textDim })
    rows.push({
      text: suggestionsVisible ? SUGGESTION_HEADER : "",
      fg: UI.textFaint,
    })
    for (const item of content.suggestions) {
      rows.push({
        text: suggestionsVisible ? `${item.key}  ${item.label}` : "",
        fg: UI.textDim,
      })
    }
  }
  return rows
}

function markChunks(nowMs: number, still: boolean): readonly TextChunk[][] {
  return renderMark({ nowMs, still }).map((row) =>
    row.map((cell) => fgChunk(cell.fg)(cell.char)),
  )
}

export type LandingAbove = {
  readonly box: BoxRenderable
  readonly markRows: readonly TextRenderable[]
}

/**
 * The mark, bottom-anchored in its zone so it sits directly on the prompt box
 * rather than floating in the middle of the empty space above it.
 */
export function createLandingAbove(ctx: CliRenderer): LandingAbove {
  const box = new BoxRenderable(ctx, {
    id: "shell-landing-above",
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    justifyContent: "flex-end",
    paddingLeft: LANDING_MARGIN,
    backgroundColor: UI.ground,
  })
  const markRows: TextRenderable[] = []
  for (let row = 0; row < MARK_ROWS; row++) {
    const line = new TextRenderable(ctx, {
      id: `shell-landing-mark-${row}`,
      height: 1,
      content: "",
      fg: UI.action,
    })
    markRows.push(line)
    box.add(line)
  }
  box.add(
    new TextRenderable(ctx, {
      id: "shell-landing-mark-gap",
      height: MARK_GAP_ROWS,
      content: "",
      fg: UI.ground,
    }),
  )
  const above: LandingAbove = { box, markRows }
  paintLandingMark(above, 0, true)
  return above
}

/**
 * Repaint the mark for the given clock. `still` holds the fully-filled frame —
 * the idle state, and the reduced-motion state.
 */
export function paintLandingMark(
  above: LandingAbove,
  nowMs: number,
  still: boolean,
): void {
  const chunks = markChunks(nowMs, still)
  above.markRows.forEach((line, index) => {
    const row = chunks[index]
    if (row !== undefined) line.content = new StyledText([...row])
  })
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
  })
  landingBelowRows(content).forEach((row, index) => {
    box.add(
      new TextRenderable(ctx, {
        id: `shell-landing-below-${index}`,
        height: 1,
        content: row.text,
        fg: row.fg,
      }),
    )
  })
  return box
}

/** Repaint the rows below the box for the current suggestion visibility. */
export function paintLandingBelow(
  box: BoxRenderable,
  content: LandingBelowContent,
  suggestionsVisible: boolean,
): void {
  const rows = landingBelowRows(content, suggestionsVisible)
  box.getChildren().forEach((child, index) => {
    const row = rows[index]
    if (row !== undefined && child instanceof TextRenderable) {
      child.content = row.text
    }
  })
}
