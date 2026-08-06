/**
 * Density ramp — the activity primitive, replacing the braille spinner.
 *
 * corbits.dev renders an ordered dither at a 4-pixel cell; a terminal has that
 * texture natively as block-density characters, so the house motif ports rather
 * than being approximated. The ramp fills left to right and its *color and
 * motion* carry the state, not a text label:
 *
 *   working    ███████▓▒░   blue,   animating
 *   done       ██████████   green,  still
 *   blocked    █████▓▒░     orange, frozen mid-fill
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

export type RampPhase = "working" | "done" | "blocked"

export type RampInput = {
  readonly phase: RampPhase
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

/** Resolve the ramp's glyphs, color and motion from the turn phase. */
export function rampFor(input: RampInput): Ramp {
  const width = input.width ?? RAMP_WIDTH

  if (input.phase === "done") {
    return { cells: SOLID.repeat(width), fg: UI.done, animating: false }
  }

  if (input.phase === "blocked") {
    return {
      cells: renderRamp(input.progress ?? BLOCKED_DEFAULT_PROGRESS, width),
      fg: UI.action,
      animating: false,
    }
  }

  return input.progress === undefined
    ? {
        cells: renderIndeterminateRamp(input.nowMs, width),
        fg: UI.inFlight,
        animating: true,
      }
    : {
        cells: renderRamp(input.progress, width),
        fg: UI.inFlight,
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
