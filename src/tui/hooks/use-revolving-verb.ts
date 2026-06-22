const VERBS = ["thinking", "streaming", "running", "reasoning", "working"] as const;

// Picks one ambient verb for the whole inference turn. The live phase still
// comes from the in-flight label; this avoids a distracting timed rotation.
export function useRevolvingVerb(active: boolean, turnKey = 0): string | undefined {
  return active ? VERBS[Math.abs(turnKey) % VERBS.length] : undefined;
}
