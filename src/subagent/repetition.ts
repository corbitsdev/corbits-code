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
export interface RepetitionConfig {
  /** Smallest normalized window (chars) considered a loop unit. */
  windowMinChars: number;
  /** Consecutive repeats of the window required to trigger. */
  repeatThreshold: number;
  /** How much normalized tail text is examined per check. */
  probeChars: number;
  /**
   * Largest normalized window (chars) the digit-folded path may fire on.
   * Only meaningful with opts.normalizeDigits — folding digit runs to one
   * placeholder can turn a healthy templated enumeration line into a
   * byte-identical period once its digits are erased. A true oscillating- or
   * monotonic-counter loop folds to a tiny period (a few chars); a templated
   * prose line folds to a much longer one. Capping the folded period length
   * lets the short, counter-shaped periods through while refusing to fire on
   * the long, prose-shaped ones. Ignored when normalizeDigits is false.
   */
  maxFoldedPeriodChars?: number;
}

// windowMinChars * repeatThreshold = 128 chars of exactly periodic text —
// far beyond anything legitimate prose or code produces by accident.
export const DEFAULT_REPETITION_CONFIG: RepetitionConfig = {
  windowMinChars: 16,
  repeatThreshold: 8,
  probeChars: 8192,
};

// Each detection pass scans the full probe tail; running it on every delta
// would put O(probeChars) work on each streamed token. Checking once per this
// many appended chars keeps detection latency in the tens of tokens while
// cutting the cost by two orders of magnitude.
export const REPETITION_CHECK_INTERVAL_CHARS = 256;

// Thinking streams are never shown to the user, so unlike text (see
// normalize() below) they can fold digit runs into one placeholder without
// risking a numbered-list or table rendering complaint. But folding still
// erases real information: a healthy templated enumeration line (a worker
// narrating "N. Ran batch N and verified N*3 records migrated" once per
// iteration) is only distinct because of its digits, so once folded, many
// such lines become one repeating ~40+ char unit and look exactly like a
// loop. The discriminator that keeps that safe is period length: a true
// oscillating- or monotonic-counter loop ("0/1 1/2 2/3 …") folds to a tiny
// period (a handful of chars — the counter digits and their separators),
// while a templated prose line folds to a much longer one (the surrounding
// sentence survives folding intact). maxFoldedPeriodChars caps the folded
// path to short periods so it only ever catches counter-shaped loops, never
// prose-shaped enumeration; the repeat threshold on top of that still
// requires a long sustained run before it trips.
export const DEFAULT_THINKING_REPETITION_CONFIG: RepetitionConfig = {
  windowMinChars: 4,
  repeatThreshold: 32,
  probeChars: 8192,
  maxFoldedPeriodChars: 16,
};

export interface RepetitionHit {
  /** The normalized window that repeats. */
  window: string;
  repeats: number;
}

// Whitespace runs collapse so wrapping and indentation differences do not
// break periodicity. Digits are deliberately NOT normalized: tables, numbered
// lists, and checklists stream rows that differ only in digits, and mapping
// digits to one symbol makes healthy structured output read as a loop. A real
// loop with an oscillating counter ("0/1.0 done" then "1/1.0 done") stays
// byte-periodic anyway — the period just spans the oscillation. The cost is
// that a loop driven by a strictly monotonic counter escapes, but that shape
// is indistinguishable from a legitimate numbered list.
//
// Format / invisible separators (ZWSP, BOM, soft hyphen, bidi marks, …) are
// stripped so a model that injects them between identical windows cannot
// evade the detector. Observed thrash loops used U+200B between repeats.
// `normalizeDigits` opts a caller into folding digit runs to one placeholder,
// which collapses a monotonic counter's varying digits into a repeating unit.
// Reserved for thinking streams (see DEFAULT_THINKING_REPETITION_CONFIG),
// which are never rendered to the user and so carry none of the numbered-list
// / table false-positive risk that keeps text normalization digit-preserving.
function normalize(text: string, normalizeDigits: boolean): string {
  const stripped = text
    .replace(/[\u200B-\u200D\uFEFF\u00AD\u2060\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ");
  return normalizeDigits ? stripped.replace(/\d+/g, "0") : stripped;
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
  opts: { normalizeDigits?: boolean } = {},
): RepetitionHit | null {
  const tail = normalize(text.slice(-config.probeChars), opts.normalizeDigits ?? false);
  if (tail.length < config.windowMinChars * config.repeatThreshold) return null;

  const reversed = [...tail].reverse().join("");
  const pi = prefixFunction(reversed);

  let best: RepetitionHit | null = null;
  for (let i = 0; i < reversed.length; i++) {
    const suffixLen = i + 1;
    const period = suffixLen - (pi[i] ?? 0);
    if (period < config.windowMinChars) continue;
    if (opts.normalizeDigits && config.maxFoldedPeriodChars !== undefined) {
      if (period > config.maxFoldedPeriodChars) continue;
    }
    if (suffixLen < period * config.repeatThreshold) continue;
    const repeats = Math.floor(suffixLen / period);
    if (best === null || repeats > best.repeats) {
      best = { window: tail.slice(tail.length - period), repeats };
    }
  }
  return best;
}
