import { useEffect, useRef, useState } from "react";

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
// Idle: no interval, no re-renders.
export function useSpinner(active: boolean, resetKey?: number): SpinnerState {
  const [frameIndex, setFrameIndex] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startRef = useRef<number | null>(null);
  // Accumulated elapsed captured when going inactive. Preserved so re-arming
  // continues the cumulative clock within the same turn (same resetKey).
  const pausedElapsedRef = useRef(0);
  // Tracks the last seen resetKey so we can detect a new turn starting.
  const lastResetKeyRef = useRef<number | undefined>(undefined);

  // A new turn begins when resetKey changes. Zero the accumulated elapsed so
  // the fresh turn's clock starts at 0 rather than the prior turn's total.
  // Run synchronously (not inside the active effect) so the reset happens
  // before the active effect reads pausedElapsedRef.
  if (resetKey !== lastResetKeyRef.current) {
    lastResetKeyRef.current = resetKey;
    pausedElapsedRef.current = 0;
    startRef.current = null;
  }

  useEffect(() => {
    if (!active) {
      // Capture elapsed before stopping. If startRef is null the spinner was
      // never running this arm — do not overwrite a meaningful paused value.
      if (startRef.current !== null) {
        pausedElapsedRef.current = Date.now() - startRef.current;
      }
      startRef.current = null;
      setFrameIndex(0);
      setElapsedMs(0);
      return undefined;
    }
    // Resume the clock from wherever it was paused. Immediately restore the
    // accumulated elapsed so the display does not flicker back to 0 before
    // the first interval tick. First activation has pausedElapsedRef === 0.
    startRef.current = computeAnchor(pausedElapsedRef.current);
    setElapsedMs(pausedElapsedRef.current);
    const interval = setInterval(() => {
      setFrameIndex((i) => (i + 1) % SPINNER_FRAMES.length);
      if (startRef.current !== null) setElapsedMs(Date.now() - startRef.current);
    }, FRAME_MS);
    return () => clearInterval(interval);
  }, [active, resetKey]);

  return { frame: SPINNER_FRAMES[frameIndex] ?? SPINNER_FRAMES[0], elapsedMs };
}
