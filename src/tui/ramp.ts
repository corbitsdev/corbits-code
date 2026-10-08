/**
 * Density ramp — the activity primitive. Two surfaces draw from it.
 *
 * The wide fill (`rampFor`) is the provider-setup status line; the single
 * cell (`rampPulse`) is the session shell's status slot, where one column
 * is all the border row can spare:
 *
 *   working    █ ▓ ▒ ░ …  cycling density — visibly moving
 *   done       █          still
 *   blocked    ▌          static half block — stillness is the signal
 *   stalled    ! / █      bang/block alternation, then static !
 *
 * `blocked` and `stalled` share a color (both wait on outside action) but
 * differ by glyph and motion, so all states read without color.
 *
 * Pure and clock-injected: `nowMs` is the only time source.
 */

import { UI } from "./theme.js";

/** Ten cells: narrow enough to read as texture, not precision. */
export const RAMP_WIDTH = 10;

/** Densest to sparsest. Index is distance behind the leading edge. */
const FEATHER = ["█", "▓", "▒", "░"] as const;
const SOLID = FEATHER[0];
const EMPTY = " ";

/** Cells the comet occupies in the indeterminate ramp, head included. */
const COMET_LENGTH = FEATHER.length;

/**
 * One full comet traversal; slow enough to read as motion, not a strobe at
 * the 250 ms status tick.
 */
export const RAMP_CYCLE_MS = 1200;

/** Where a blocked ramp freezes when the caller has no real progress. */
const BLOCKED_DEFAULT_PROGRESS = 0.5;

/** Glyph shown in place of a block during the off phase of the stall blink. */
export const STALL_GLYPH = "!";

/** Static single cell for a turn frozen on an operator gate. */
const BLOCKED_GLYPH = "▌";

/** One full on/off cycle of the stall blink. */
export const STALL_BLINK_CYCLE_MS = 900;

/**
 * How long the stall blink runs before settling to a static bang. A stall
 * can last minutes; an unbounded blink would strobe until it means
 * nothing. The burst spends attention up front; the static bang still
 * reads as a problem.
 */
export const STALL_BLINK_BURST_MS = STALL_BLINK_CYCLE_MS * 9;

/**
 * Whether `nowMs` is in the solid half of the stall blink; exported so every
 * stalled surface blinks on the same clock.
 */
export function stallBlinkOn(nowMs: number): boolean {
  const phase =
    ((nowMs % STALL_BLINK_CYCLE_MS) + STALL_BLINK_CYCLE_MS) %
    STALL_BLINK_CYCLE_MS;
  return phase < STALL_BLINK_CYCLE_MS / 2;
}

/** Whether the burst still runs for a stall that began `stalledForMs` ago. */
export function stallBlinkActive(stalledForMs: number): boolean {
  return stalledForMs >= 0 && stalledForMs < STALL_BLINK_BURST_MS;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Determinate fill: solid cells up to `progress`, then a short dither
 * feather at the leading edge so the boundary reads as texture, not a hard
 * stop. A full ramp is entirely solid.
 */
export function renderRamp(progress: number, width = RAMP_WIDTH): string {
  if (width <= 0) return "";
  const filled = Math.floor(clamp01(progress) * width);
  let out = "";
  for (let i = 0; i < width; i++) {
    const behindEdge = i - filled;
    out += behindEdge < 0 ? SOLID : (FEATHER[behindEdge + 1] ?? EMPTY);
  }
  return out;
}

/**
 * Indeterminate fill: a comet traveling left to right and wrapping. Most
 * work has no denominator, so it animates rather than faking a percentage.
 */
export function renderIndeterminateRamp(
  nowMs: number,
  width = RAMP_WIDTH,
): string {
  if (width <= 0) return "";
  const span = width + COMET_LENGTH;
  const phase = ((nowMs % RAMP_CYCLE_MS) + RAMP_CYCLE_MS) % RAMP_CYCLE_MS;
  const head = Math.floor((phase / RAMP_CYCLE_MS) * span);
  let out = "";
  for (let i = 0; i < width; i++) {
    const behindHead = head - i;
    out += behindHead < 0 ? EMPTY : (FEATHER[behindHead] ?? EMPTY);
  }
  return out;
}

export type RampPhase = "working" | "done" | "blocked" | "stalled";

/**
 * Wide-fill phases. Only a live session reports a stall, and it paints the
 * single cell, so a wide stall would produce glyphs nothing renders.
 */
export type RampFillPhase = Exclude<RampPhase, "stalled">;

/**
 * Stalled duration, or null when not stalled. Required: it decides whether
 * the blink still runs; forgetting it paints a permanent strobe.
 */
export type StallAge = number | null;

export interface PulseInput {
  readonly phase: RampPhase;
  readonly nowMs: number;
  readonly stalledForMs: StallAge;
}

/** The one glyph the session shell's status slot can afford. */
export function rampPulse(input: PulseInput): string {
  if (input.phase === "done") return SOLID;
  if (input.phase === "blocked") return BLOCKED_GLYPH;
  if (input.phase === "stalled") {
    const blinking =
      input.stalledForMs !== null && stallBlinkActive(input.stalledForMs);
    return blinking && stallBlinkOn(input.nowMs) ? SOLID : STALL_GLYPH;
  }
  const phase = ((input.nowMs % RAMP_CYCLE_MS) + RAMP_CYCLE_MS) % RAMP_CYCLE_MS;
  const step = Math.floor((phase / RAMP_CYCLE_MS) * FEATHER.length);
  return FEATHER[Math.min(FEATHER.length - 1, step)] ?? SOLID;
}

/** The turn phase's color, shared by every surface that paints the phase. */
export function rampFg(phase: RampPhase): string {
  if (phase === "done") return UI.done;
  if (phase === "blocked" || phase === "stalled") return UI.action;
  return UI.inFlight;
}

/**
 * Whether the phase still has frames to draw. False for terminal and waiting
 * states and for a settled stall, so the caller's tick can fall back to its
 * slow cadence.
 */
export function rampAnimating(
  phase: RampPhase,
  stalledForMs: StallAge,
): boolean {
  if (phase === "done" || phase === "blocked") return false;
  if (phase === "stalled") {
    return stalledForMs !== null && stallBlinkActive(stalledForMs);
  }
  return true;
}

export interface RampInput {
  readonly phase: RampFillPhase;
  readonly nowMs: number;
  /** Omit when the work has no denominator — the ramp animates instead. */
  readonly progress?: number;
  readonly width?: number;
}

export interface Ramp {
  readonly cells: string;
  readonly fg: string;
  /** False when the ramp is a terminal state and must hold still. */
  readonly animating: boolean;
}

/** Resolve the wide fill's glyphs, color and motion from the turn phase. */
export function rampFor(input: RampInput): Ramp {
  const width = input.width ?? RAMP_WIDTH;
  const fg = rampFg(input.phase);

  if (input.phase === "done") {
    return { cells: SOLID.repeat(width), fg, animating: false };
  }

  if (input.phase === "blocked") {
    return {
      cells: renderRamp(input.progress ?? BLOCKED_DEFAULT_PROGRESS, width),
      fg,
      animating: false,
    };
  }

  return {
    cells:
      input.progress === undefined
        ? renderIndeterminateRamp(input.nowMs, width)
        : renderRamp(input.progress, width),
    fg,
    animating: true,
  };
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
      : ` · ${Math.floor(elapsedMs / 1000)}s`;
  return `${ramp.cells}  ${label}${elapsed}`;
}
