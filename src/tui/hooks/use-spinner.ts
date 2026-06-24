import { useRef } from "react";

// Braille spinner — a smooth, low-noise glyph cycle that reads as "alive"
// without shouting. Eighty milliseconds per frame is fast enough to feel
// fluid, slow enough to stay calm.
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const SPINNER_FRAME_MS = 80;

export type SpinnerTiming = { anchor: number | null };

// Computes the new start anchor so the elapsed clock is cumulative across
// re-arms. The anchor is set in the past by `pausedElapsedMs` so that
// Date.now() - anchor continues from the preserved value rather than resetting
// to zero. Exported for unit testing only.
export function computeAnchor(pausedElapsedMs: number): number {
  return Date.now() - pausedElapsedMs;
}

export function spinnerFrameIndex(now = Date.now()): number {
  return Math.floor(now / SPINNER_FRAME_MS) % SPINNER_FRAMES.length;
}

export function spinnerFrameAt(now = Date.now()): string {
  return SPINNER_FRAMES[spinnerFrameIndex(now)] ?? SPINNER_FRAMES[0]!;
}

export function elapsedMsFromAnchor(anchor: number | null, now = Date.now()): number {
  return anchor === null ? 0 : Math.max(0, now - anchor);
}

// Tracks cumulative elapsed timing for the in-flight row. Glyph animation runs
// inside InFlightIndicator so the rest of the tree is not repainted every frame.
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
export function useSpinner(active: boolean, resetKey?: number): SpinnerTiming {
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
    return { anchor: null };
  }

  return { anchor: startRef.current };
}
