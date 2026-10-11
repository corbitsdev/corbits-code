/**
 * The bottom-left status slot: whatever the session is currently doing.
 *
 * It rides the prompt box's bottom border. Idle it reads `corbits code`;
 * while a turn runs it reads the live phase — `thinking`, `responding`,
 * the running tool's name — led by a single density cell (`rampPulse` in
 * `ramp.ts`): the word alone printed the same static `working` for a
 * live run and a hung one. The cell cycles while the turn moves, holds a
 * static half block on an operator gate, and blinks a bang when stalled
 * (glyph and motion carry the states — see ramp.ts).
 *
 * Cell and word share the phase's color, so the slot never disagrees
 * with it. Pure and clock-injected: `nowMs` in, cells out.
 */

import { type MarkCell } from "./mark-anim.js";
import { rampFg, rampPulse, type RampPhase, type StallAge } from "./ramp.js";
import { UI } from "./theme.js";
import { stringWidth } from "./view/height.js";

export const LOCKUP_WORDMARK = "corbits code";

/** How long a state change takes to cross the fade ramp. */
export const LOCKUP_FADE_MS = 240;

/**
 * Fade ramps, faintest first. A terminal has no alpha, so a transition steps
 * through the warm dim tones toward its resting tone instead of blending.
 */
const WORDMARK_FADE = [UI.textFaint, UI.textDim] as const;
const PHASE_FADE = [UI.textFaint, UI.textDim, UI.text] as const;

export interface LockupInput {
  readonly nowMs: number;
  /** Hold the settled frame: idle session, or reduced motion. */
  readonly still: boolean;
  /** Live phase word, or null when the session is idle. */
  readonly phase: string | null;
  /** Clock reading when the slot's text last changed. */
  readonly changedMs: number;
  /** The turn's ramp phase, or null when the session is idle. */
  readonly rampPhase: RampPhase | null;
  /** How long the turn has been stalled, or null when it is not stalled. */
  readonly stalledForMs: StallAge;
}

/** What the slot says: the phase while a turn runs, the wordmark otherwise. */
export function lockupLabel(phase: string | null): string {
  const live = phase?.trim() ?? "";
  return live.length > 0 ? live : LOCKUP_WORDMARK;
}

/**
 * Columns the slot paints. Measured off the cells it draws, not the label,
 * so the reservation cannot drift when the pulse is present or the label
 * is wide (CJK) or astral.
 */
export function lockupWidth(input: LockupInput): number {
  return stringWidth(lockupText(lockupCells(input)));
}

/**
 * The slot as coloured cells, left to right. `still` is the settled state:
 * the idle wordmark at its resting tones, nothing left to animate. A live
 * turn leads with the phase's density cell and tint; idle keeps the
 * neutral crossfade because nothing is running to draw a phase from.
 */
export function lockupCells(input: LockupInput): readonly MarkCell[] {
  const live = (input.phase?.trim().length ?? 0) > 0;
  const label = lockupLabel(input.phase);

  if (live && input.rampPhase !== null) {
    const fg = rampFg(input.rampPhase);
    const pulse = rampPulse({
      phase: input.rampPhase,
      nowMs: input.nowMs,
      stalledForMs: input.stalledForMs,
    });
    return [...`${pulse} ${label}`].map((char) => ({ char, fg }));
  }

  const progress = fadeProgress(input);
  const cells: MarkCell[] = [];
  const textTone = toneAt(live ? PHASE_FADE : WORDMARK_FADE, progress);
  for (const char of label) {
    cells.push({ char, fg: textTone });
  }
  return cells;
}

/**
 * 0 the moment the text changes, 1 once the fade has run. A settled slot
 * skips it: idle is genuinely still and the monitor tick that would carry
 * the frames has stopped.
 */
function fadeProgress(input: LockupInput): number {
  if (input.still) return 1;
  const elapsed = input.nowMs - input.changedMs;
  if (!Number.isFinite(elapsed) || elapsed >= LOCKUP_FADE_MS) return 1;
  return elapsed <= 0 ? 0 : elapsed / LOCKUP_FADE_MS;
}

function toneAt(ramp: readonly string[], progress: number): string {
  const index = Math.min(ramp.length - 1, Math.floor(progress * ramp.length));
  return ramp[Math.max(0, index)] ?? ramp[ramp.length - 1] ?? UI.textDim;
}

/** Plain-text rendering of a lockup frame — what the shape tests read. */
export function lockupText(cells: readonly MarkCell[]): string {
  return cells.map((cell) => cell.char).join("");
}
