import { useEffect, useState } from "react";

// 1s resolution is enough for a session timer; faster would burn renders for no
// visible change.
const TICK_MS = 1000;

// Monotonically increasing elapsed since the session start. Unlike the per-turn
// spinner clock, this never resets between turns — it tracks the whole session.
// `startedAt` is held in App state so a `/new` session resets the clock.
export function useSessionClock(startedAt: number): number {
  const [elapsedMs, setElapsedMs] = useState(() => Date.now() - startedAt);

  useEffect(() => {
    setElapsedMs(Date.now() - startedAt);
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), TICK_MS);
    return () => clearInterval(id);
  }, [startedAt]);

  return elapsedMs;
}
