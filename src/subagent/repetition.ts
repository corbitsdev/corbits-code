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

// windowMinChars * repeatThreshold = 8 * 16 = 128 chars of exactly periodic
// text — far beyond anything legitimate prose or code produces by accident.
// windowMinChars sits at 8 because live loops repeat units as short as 10
// chars ("Groaning. " emitted ~1,363 times), which a 16-char floor never sees;
// the repeat threshold rises to 16 in compensation so the minimum periodic
// span stays at 128 chars. Structural tics that legitimately repeat ("- item\n"
// normalizes to 7 chars) still fall under the window floor, and longer healthy
// repeats (a 6-row table separator, 3 identical code lines, a repeat(4)
// paragraph) stay far below 16 consecutive repeats.
export const DEFAULT_REPETITION_CONFIG: RepetitionConfig = {
  windowMinChars: 8,
  repeatThreshold: 16,
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

// Second, folded pass over *text* streams, for the flood shapes the default
// (digit-preserving) config is structurally blind to. Live traces ending as
// inference-error (670K wasted streamed chars) showed: incrementing counters
// ("14279 14280 14281…", "5620/5620. 5621/5621…" — never byte-periodic),
// repeated timestamps with drift ("18:22:27. 18:22:28."), "0% 0% 0%…",
// repeated "```\n" fences and "}\n" braces, and emoji floods ("🤔 " ×~40K
// chars). All fold (or already normalize) to a tiny 2–16 char period.
//
// The safety story for visible text is different from thinking, hence the
// stricter numbers rather than reusing the thinking config:
// - maxFoldedPeriodChars 16 refuses prose-shaped folds exactly as it does for
//   thinking: a numbered-list or table row folds to a ~30–50 char period and
//   never fires (see the normalize() rationale below).
// - windowMinChars 2 (vs thinking's 4) reaches the shortest observed units:
//   "0% " and "} " fold to 2–3 chars, below the thinking floor.
// - repeatThreshold 64 (vs 32): the residual false-positive risk for text is
//   a user-requested raw enumeration ("print 1..N"), which folds to "0 " —
//   a legit dump of a few dozen numbers stays under 64 consecutive repeats,
//   while the observed floods repeat thousands of times. Minimum folded
//   periodic span: 2 * 64 = 128 chars.
export const DEFAULT_TEXT_FOLDED_REPETITION_CONFIG: RepetitionConfig = {
  windowMinChars: 2,
  repeatThreshold: 64,
  probeChars: 8192,
  maxFoldedPeriodChars: 16,
};

export type RepetitionHit = {
  /** The normalized window that repeats. */
  window: string;
  repeats: number;
};

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
// The digit-preserving default protects text streams' numbered lists and
// tables; folded detection runs on them only as a second pass capped to tiny
// periods (DEFAULT_TEXT_FOLDED_REPETITION_CONFIG), and uncapped-in-spirit on
// thinking streams (DEFAULT_THINKING_REPETITION_CONFIG), which are never
// rendered to the user and so carry less false-positive cost.
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

  // Reverse by code point so surrogate pairs survive intact — an emoji flood
  // ("🤔 " ×thousands) must stay byte-periodic after reversal. The prefix
  // function and window extraction then both count plain UTF-16 units of the
  // (pair-preserving) reversed string, so periods and slices stay consistent.
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

/** Tunables for the contentless-growth guard. */
export type ContentlessGrowthConfig = {
  /** Raw streamed chars per measurement window. */
  rawWindowChars: number;
  /** A window with fewer visible chars than this counts as contentless. */
  minVisibleChars: number;
};

// detectRepetition can never see a zero-width flood: normalize() strips
// invisibles *before* the periodicity check, so thousands of U+200C/U+200D
// chars (observed live: 500–53,000 per stream) collapse to a short, healthy-
// looking string. This guard watches the inverse signal — raw text keeps
// growing while its visible content does not. The bar: 2048 raw chars with
// fewer than 32 visible. Legitimate sparse output never approaches it — even
// a heavily indented code block or a wide table row carries hundreds of
// visible chars per 2048 raw, and a healthy stream would need 64:1
// invisible-or-whitespace-to-content to trip it.
export const DEFAULT_CONTENTLESS_GROWTH_CONFIG: ContentlessGrowthConfig = {
  rawWindowChars: 2048,
  minVisibleChars: 32,
};

export type ContentlessGrowthState = {
  /** Raw chars accumulated in the current window. */
  rawChars: number;
  /** Visible (invisible-stripped, whitespace-removed) chars in the window. */
  visibleChars: number;
};

export const INITIAL_CONTENTLESS_GROWTH_STATE: ContentlessGrowthState = {
  rawChars: 0,
  visibleChars: 0,
};

// Whitespace is removed rather than collapsed: a window of pure newlines is
// as contentless as one of pure ZWJ, and counting collapsed runs would let a
// space-interleaved flood (ZWJ, space, ZWJ, space, …) smuggle half its
// length past the epsilon.
function visibleLength(token: string): number {
  return normalize(token, false).replace(/ /g, "").length;
}

/**
 * Fold one streamed token into the contentless-growth window. Returns the
 * next state and whether the just-completed window was contentless: raw text
 * grew by a full window while visible content grew less than the epsilon.
 * Pure reducer — the caller owns the state across deltas; the window resets
 * on completion either way, so one visible-rich window re-arms the guard.
 */
export function trackContentlessGrowth(
  state: ContentlessGrowthState,
  token: string,
  config: ContentlessGrowthConfig = DEFAULT_CONTENTLESS_GROWTH_CONFIG,
): { state: ContentlessGrowthState; hit: boolean } {
  const rawChars = state.rawChars + token.length;
  const visibleChars = state.visibleChars + visibleLength(token);
  if (rawChars < config.rawWindowChars) {
    return { state: { rawChars, visibleChars }, hit: false };
  }
  return {
    state: INITIAL_CONTENTLESS_GROWTH_STATE,
    hit: visibleChars < config.minVisibleChars,
  };
}
