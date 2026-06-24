import { useRef } from "react";

// Braille spinner — a smooth, low-noise glyph cycle that reads as "alive"
// without shouting. Eighty milliseconds per frame is fast enough to feel
// fluid, slow enough to stay calm.
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const FRAME_MS = 80;

export type SpinnerState = { frame: string; elapsedMs: number };

// Computes the new start anchor so the elapsed clock is cumulative across
// re-arms. The anchor is set in the past by `pausedElapsedMs` so that
// Date.now() - anchor continues from the preserved value rather than resetting
// to zero. Exported for unit testing only.
export function computeAnchor(pausedElapsedMs: number): number {
  return Date.now() - pausedElapsedMs;
}

export function spinnerFrameIndex(now = Date.now()): number {
  return Math.floor(now / FRAME_MS) % SPINNER_FRAMES.length;
}

// Animate a spinner only while `active`. Returns the current frame and the
// cumulative elapsed time so callers can surface a "still working" hint.
//
// Elapsed is cumulative within a turn: brief pauses (e.g. between a tool
// result and the next model chunk) do not reset the counter. Going inactive
// snaps the display back to 0, but the accumulated value is preserved in a ref
// so the clock resumes correctly when active becomes true again within the same
// turn.
//
// `resetKey` identifies the current user turn. When resetKey changes, the
// accumulated elapsed is zeroed so a new turn always starts the clock fresh
// instead of inheriting the prior turn's running total.
//
// No local interval: the parent re-renders on the agent stream tick (~30fps)
// and advances the glyph from wall-clock time.
export function useSpinner(active: boolean, resetKey?: number): SpinnerState {
  const startRef = useRef<number | null>(null);
  const pausedElapsedRef = useRef(0);
  const lastResetKeyRef = useRef<number | undefined>(undefined);
  const wasActiveRef = useRef(false);

  if (resetKey !== lastResetKeyRef.current) {
    lastResetKeyRef.current = resetKey;
    pausedElapsedRef.current = 0;
    startRef.current = null;
  }

  if (!active && wasActiveRef.current) {
    if (startRef.current !== null) {
      pausedElapsedRef.current = Date.now() - startRef.current;
    }
    startRef.current = null;
  }

  if (active && !wasActiveRef.current) {
    startRef.current = computeAnchor(pausedElapsedRef.current);
  }

  wasActiveRef.current = active;

  if (!active) {
    return { frame: SPINNER_FRAMES[0]!, elapsedMs: 0 };
  }

  const now = Date.now();
  const elapsedMs = startRef.current !== null ? now - startRef.current : 0;
  const frame = SPINNER_FRAMES[spinnerFrameIndex(now)] ?? SPINNER_FRAMES[0]!;
  return { frame, elapsedMs };
}
