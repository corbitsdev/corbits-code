import { useEffect, useState } from "react";

// Action verbs that cycle next to the steer hint while the agent runs. The set
// is deliberately generic — the precise phase already lives in the in-flight
// label ("Thinking…", "Responding…", "Running tool…"); this is the ambient
// "alive" motion the user asked for.
const VERBS = ["thinking", "streaming", "running", "reasoning", "composing", "working"] as const;

// Slow enough to read as a gentle rotation rather than a flicker.
const ROTATION_MS = 1400;

// Returns the current rotating verb while `active`, or undefined when idle so
// the caller can omit the whole prefix.
export function useRevolvingVerb(active: boolean): string | undefined {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setIndex((i) => (i + 1) % VERBS.length), ROTATION_MS);
    return () => clearInterval(id);
  }, [active]);

  return active ? VERBS[index % VERBS.length] : undefined;
}
