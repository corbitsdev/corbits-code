import { useEffect, useRef, useState } from "react";

// Braille spinner — a smooth, low-noise glyph cycle that reads as "alive"
// without shouting. Eighty milliseconds per frame is fast enough to feel
// fluid, slow enough to stay calm.
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const FRAME_MS = 80;

export type SpinnerState = { frame: string; elapsedMs: number };

// Animate a spinner only while `active`. Returns the current frame and the time
// elapsed since it became active, so callers can surface a gentle "still
// working" hint once a wait runs long. Idle: no interval, no re-renders.
export function useSpinner(active: boolean): SpinnerState {
  const [frameIndex, setFrameIndex] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      startRef.current = null;
      setFrameIndex(0);
      setElapsedMs(0);
      return undefined;
    }
    startRef.current = Date.now();
    const interval = setInterval(() => {
      setFrameIndex((i) => (i + 1) % SPINNER_FRAMES.length);
      if (startRef.current !== null) setElapsedMs(Date.now() - startRef.current);
    }, FRAME_MS);
    return () => clearInterval(interval);
  }, [active]);

  return { frame: SPINNER_FRAMES[frameIndex] ?? SPINNER_FRAMES[0], elapsedMs };
}
