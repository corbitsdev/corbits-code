/**
 * Pure degenerate-repetition detection for streamed assistant text.
 *
 * The turn-level detectors (thrash, no-progress) only see completed turns; a
 * model that loops the same sentence inside one never-ending streaming turn is
 * invisible to them. This module watches the accumulated text of the current
 * inference cycle and flags a trailing window that repeats verbatim past a
 * threshold, so the run loop can abort the cycle instead of streaming forever.
 */

/** Tunable thresholds for the trailing-window repetition check. */
export type RepetitionConfig = {
  /** Smallest normalized window (chars) considered a loop unit. */
  windowMinChars: number;
  /** Consecutive repeats of the window required to trigger. */
  repeatThreshold: number;
  /** How much normalized tail text is examined per check. */
  probeChars: number;
};

// windowMinChars * repeatThreshold = 128 chars of exactly periodic text —
// far beyond anything legitimate prose or code produces by accident.
export const DEFAULT_REPETITION_CONFIG: RepetitionConfig = {
  windowMinChars: 16,
  repeatThreshold: 8,
  probeChars: 8192,
};

/** Cap on retained cycle text; older text is dropped from the front. */
export const CYCLE_TEXT_CAP_CHARS = 262_144;

export type RepetitionHit = {
  /** The normalized window that repeats. */
  window: string;
  repeats: number;
};

/** Append a streamed token to the cycle buffer, keeping only the tail. */
export function appendCycleText(
  text: string,
  token: string,
  cap: number = CYCLE_TEXT_CAP_CHARS,
): string {
  const joined = text + token;
  return joined.length > cap ? joined.slice(joined.length - cap) : joined;
}

// Counters inside a loop ("0/1.0 done" vs "1/1.0 done") flip between
// iterations; mapping every digit run to one symbol makes those iterations
// compare equal. Whitespace runs collapse for the same reason.
function normalize(text: string): string {
  return text.replace(/\d+/g, "#").replace(/\s+/g, " ");
}

function prefixFunction(s: string): Int32Array {
  const pi = new Int32Array(s.length);
  for (let i = 1; i < s.length; i++) {
    let k = pi[i - 1] ?? 0;
    while (k > 0 && s[i] !== s[k]) k = pi[k - 1] ?? 0;
    if (s[i] === s[k]) k++;
    pi[i] = k;
  }
  return pi;
}

/**
 * Detect a repeating trailing window in the cycle text.
 *
 * The prefix function of the reversed tail yields, for every suffix of the
 * tail, its smallest period in one O(probe) pass. The longest suffix whose
 * period meets the window and repeat thresholds wins.
 */
export function detectRepetition(
  text: string,
  config: RepetitionConfig = DEFAULT_REPETITION_CONFIG,
): RepetitionHit | null {
  const tail = normalize(text.slice(-config.probeChars));
  if (tail.length < config.windowMinChars * config.repeatThreshold) return null;

  const reversed = [...tail].reverse().join("");
  const pi = prefixFunction(reversed);

  let best: RepetitionHit | null = null;
  for (let i = 0; i < reversed.length; i++) {
    const suffixLen = i + 1;
    const period = suffixLen - (pi[i] ?? 0);
    if (period < config.windowMinChars) continue;
    if (suffixLen < period * config.repeatThreshold) continue;
    const repeats = Math.floor(suffixLen / period);
    if (best === null || repeats > best.repeats) {
      best = { window: tail.slice(tail.length - period), repeats };
    }
  }
  return best;
}
