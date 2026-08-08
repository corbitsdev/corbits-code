/**
 * Density ramp — the activity primitive, replacing the braille spinner.
 *
 * corbits.dev renders an ordered dither at a 4-pixel cell; a terminal has that
 * texture natively as block-density characters, so the house motif ports rather
 * than being approximated. Two surfaces draw from it, at two widths.
 *
 * The wide fill (`rampFor`) is the provider-setup status line:
 *
 *   working    ███████▓▒░   bronze, comet crawling left to right
 *   done       ██████████   green,  still
 *   blocked    █████▓▒░     orange, frozen mid-fill
 *
 * The single cell (`rampPulse`) is the session shell's bottom-left status slot,
 * where one column is all the border row can spare:
 *
 *   working    █ ▓ ▒ ░ …    bronze, cycling density — it visibly moves
 *   done       █            green,  still
 *   blocked    ▌            orange, one static half block — stillness is the signal
 *   stalled    ! / █        orange, bangs alternating with a block, then static !
 *
 * `blocked` and `stalled` share a color deliberately — both name a turn waiting
 * on outside action — but must never be confused for each other, and neither
 * may be confused with a live one. Every distinction above is carried by glyph
 * and motion before color, so all four survive a monochrome terminal.
 *
 * Pure and clock-injected: `nowMs` is the only time source, so the caller's
 * existing tick drives the animation and tests drive it deterministically.
 */

import { UI } from "./theme.js"

/**
 * Ten cells. Narrow enough to read as texture rather than implying a precision
 * the underlying work does not have.
 */
export const RAMP_WIDTH = 10

/** Densest to sparsest. Index is distance behind the leading edge. */
const FEATHER = ["█", "▓", "▒", "░"] as const
const SOLID = FEATHER[0]
const EMPTY = " "

/** Cells the comet occupies in the indeterminate ramp, head included. */
const COMET_LENGTH = FEATHER.length

/**
 * One full traversal of the indeterminate comet. Slow enough to read as
 * deliberate motion rather than a strobe at the 250 ms status tick.
 */
export const RAMP_CYCLE_MS = 1200

/** Where a blocked ramp freezes when the caller has no real progress. */
const BLOCKED_DEFAULT_PROGRESS = 0.5

/** Glyph shown in place of a block during the off phase of the stall blink. */
export const STALL_GLYPH = "!"

/** Static single cell for a turn frozen on an operator gate. */
const BLOCKED_GLYPH = "▌"

/** One full on/off cycle of the stall blink. */
export const STALL_BLINK_CYCLE_MS = 900

/**
 * How long the stall blink runs before settling to a static bang.
 *
 * A stall notice arms at 90s of silence and the abort does not land until 900s,
 * so an unbounded blink would strobe for a quarter of an hour. An alarm that is
 * identical at second one and minute thirteen stops being an alarm — the
 * operator learns to filter it, which is the exact failure this indicator
 * exists to fix. So the blink is a burst: it spends its attention up front,
 * where the state is news, then holds a bang that still reads as a problem to
 * anyone arriving late and still differs from working (which moves) and blocked
 * (which is a block glyph) with no color and no motion at all. Settling also
 * lets the tick fall back to the slow cadence instead of holding an animation
 * frame budget open for the rest of the stall, and gives a motion-sensitive
 * operator a bounded rather than indefinite strobe.
 */
export const STALL_BLINK_BURST_MS = STALL_BLINK_CYCLE_MS * 9

/**
 * Whether `nowMs` falls in the "on" (solid) half of the stall blink. Exported
 * so any surface painting a stalled phase blinks on the same clock rather than
 * each inventing its own.
 */
export function stallBlinkOn(nowMs: number): boolean {
  const phase =
    ((nowMs % STALL_BLINK_CYCLE_MS) + STALL_BLINK_CYCLE_MS) %
    STALL_BLINK_CYCLE_MS
  return phase < STALL_BLINK_CYCLE_MS / 2
}

/** Whether the burst is still running for a stall that began `stalledForMs` ago. */
export function stallBlinkActive(stalledForMs: number): boolean {
  return stalledForMs >= 0 && stalledForMs < STALL_BLINK_BURST_MS
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * Determinate fill: solid cells up to `progress`, then a short dither feather
 * at the leading edge so the boundary reads as texture instead of a hard stop.
 * A full ramp is entirely solid.
 */
export function renderRamp(progress: number, width = RAMP_WIDTH): string {
  if (width <= 0) return ""
  const filled = Math.floor(clamp01(progress) * width)
  let out = ""
  for (let i = 0; i < width; i++) {
    const behindEdge = i - filled
    out += behindEdge < 0 ? SOLID : (FEATHER[behindEdge + 1] ?? EMPTY)
  }
  return out
}

/**
 * Indeterminate fill: a comet traveling left to right and wrapping. Most coding
 * work has no denominator, so this animates rather than faking a percentage.
 */
export function renderIndeterminateRamp(
  nowMs: number,
  width = RAMP_WIDTH,
): string {
  if (width <= 0) return ""
  const span = width + COMET_LENGTH
  const phase = ((nowMs % RAMP_CYCLE_MS) + RAMP_CYCLE_MS) % RAMP_CYCLE_MS
  const head = Math.floor((phase / RAMP_CYCLE_MS) * span)
  let out = ""
  for (let i = 0; i < width; i++) {
    const behindHead = head - i
    out +=
      behindHead < 0 ? EMPTY : (FEATHER[behindHead] ?? EMPTY)
  }
  return out
}

export type RampPhase = "working" | "done" | "blocked" | "stalled"

/**
 * The phases the wide fill draws. A stall is only ever reported by a live
 * session, and the only surface a live session paints is the single cell, so
 * widening a stall would produce glyphs nothing renders.
 */
export type RampFillPhase = Exclude<RampPhase, "stalled">

/**
 * How long the turn has been stalled, or null when it is not stalled. Required
 * rather than defaulted: it is what decides whether the blink is still running,
 * and a caller that forgets it would silently paint a permanent strobe.
 */
export type StallAge = number | null

export type PulseInput = {
  readonly phase: RampPhase
  readonly nowMs: number
  readonly stalledForMs: StallAge
}

/** The one glyph the session shell's status slot can afford. */
export function rampPulse(input: PulseInput): string {
  if (input.phase === "done") return SOLID
  if (input.phase === "blocked") return BLOCKED_GLYPH
  if (input.phase === "stalled") {
    const blinking =
      input.stalledForMs !== null && stallBlinkActive(input.stalledForMs)
    return blinking && stallBlinkOn(input.nowMs) ? SOLID : STALL_GLYPH
  }
  const phase = ((input.nowMs % RAMP_CYCLE_MS) + RAMP_CYCLE_MS) % RAMP_CYCLE_MS
  const step = Math.floor((phase / RAMP_CYCLE_MS) * FEATHER.length)
  return FEATHER[Math.min(FEATHER.length - 1, step)] ?? SOLID
}

/** The turn phase's color, shared by every surface that paints the phase. */
export function rampFg(phase: RampPhase): string {
  if (phase === "done") return UI.done
  if (phase === "blocked" || phase === "stalled") return UI.action
  return UI.inFlight
}

/**
 * Whether the phase still has frames left to draw. False for the terminal and
 * waiting states, and false for a stall once its blink burst has settled, so
 * the caller's tick can fall back to its slow cadence.
 */
export function rampAnimating(phase: RampPhase, stalledForMs: StallAge): boolean {
  if (phase === "done" || phase === "blocked") return false
  if (phase === "stalled") {
    return stalledForMs !== null && stallBlinkActive(stalledForMs)
  }
  return true
}

export type RampInput = {
  readonly phase: RampFillPhase
  readonly nowMs: number
  /** Omit when the work has no denominator — the ramp animates instead. */
  readonly progress?: number
  readonly width?: number
}

export type Ramp = {
  readonly cells: string
  readonly fg: string
  /** False when the ramp is a terminal state and must hold still. */
  readonly animating: boolean
}

/** Resolve the wide fill's glyphs, color and motion from the turn phase. */
export function rampFor(input: RampInput): Ramp {
  const width = input.width ?? RAMP_WIDTH
  const fg = rampFg(input.phase)

  if (input.phase === "done") {
    return { cells: SOLID.repeat(width), fg, animating: false }
  }

  if (input.phase === "blocked") {
    return {
      cells: renderRamp(input.progress ?? BLOCKED_DEFAULT_PROGRESS, width),
      fg,
      animating: false,
    }
  }

  return {
    cells:
      input.progress === undefined
        ? renderIndeterminateRamp(input.nowMs, width)
        : renderRamp(input.progress, width),
    fg,
    animating: true,
  }
}

/** `███████▓▒░  working · 14s` — ramp, lowercase label, optional elapsed. */
export function rampLine(
  ramp: Ramp,
  label: string,
  elapsedMs?: number,
): string {
  const elapsed =
    elapsedMs === undefined || elapsedMs < 0
      ? ""
      : ` · ${Math.floor(elapsedMs / 1000)}s`
  return `${ramp.cells}  ${label}${elapsed}`
}
