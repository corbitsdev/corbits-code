/**
 * Generic exact-period detector over an ordered sequence: finds the shortest
 * period p such that the tail of the sequence is p repeated at least the
 * required number of times, with an optional distinct-unit floor to reject
 * degenerate runs (e.g. a monochrome span that is trivially "periodic" at
 * every length).
 *
 * Lifted out of tui-opentui/stall-watchdog.ts's character-stream detector —
 * same shape (shortest-period-that-repeats-enough), generalized to run over
 * any sequence of comparable items, not just characters. stall-watchdog's
 * detectRepetition and director.ts's tool-fingerprint thrash check both
 * delegate here rather than each hand-rolling the search.
 */

export interface SequencePeriodCheck {
  readonly repeating: boolean;
  readonly period: number | null;
  readonly repeats: number;
}

export interface SequencePeriodOptions<T> {
  readonly minPeriod: number;
  readonly maxPeriod: number;
  /**
   * Repeats required for a period to count as a cycle. A fixed number, or a
   * function of the candidate period when different period lengths warrant
   * different bars.
   */
  readonly minRepeats: number | ((period: number) => number);
  readonly equals?: (a: T, b: T) => boolean;
  /**
   * Minimum distinct units required within the repeating span itself, as a
   * function of period. Omit to skip the check.
   */
  readonly minDistinct?: (period: number) => number;
  /** Key used for the distinct-unit count when T is not itself string-safe. */
  readonly keyOf?: (item: T) => string;
}

/**
 * Length of the exact-period run ending at the last element of `seq`,
 * including the base period itself. Walks backwards from the end; stops at
 * the first mismatch or the start of the sequence.
 */
function periodicSuffixLength<T>(
  seq: readonly T[],
  period: number,
  equals: (a: T, b: T) => boolean,
): number {
  let i = seq.length - 1;
  let j = i - period;
  let matched = 0;
  while (j >= 0 && equals(seq[i] as T, seq[j] as T)) {
    matched++;
    i--;
    j--;
  }
  return matched + period;
}

export function detectSequencePeriod<T>(
  seq: readonly T[],
  options: SequencePeriodOptions<T>,
): SequencePeriodCheck {
  const equals = options.equals ?? ((a: T, b: T) => a === b);
  const minRepeatsFor =
    typeof options.minRepeats === "function"
      ? options.minRepeats
      : (() => {
          const fixed = options.minRepeats as number;
          return () => fixed;
        })();
  // Periods longer than seq.length / minRepeats cannot mathematically reach
  // the occurrence threshold, so they are skipped rather than scanned — same
  // optimization as the original character-stream detector. Only applies
  // when minRepeats is a fixed number; a per-period function may allow
  // longer periods a lower bar, so the full maxPeriod is scanned instead.
  const maxPeriod =
    typeof options.minRepeats === "number"
      ? Math.min(options.maxPeriod, Math.floor(seq.length / options.minRepeats))
      : options.maxPeriod;

  for (let period = options.minPeriod; period <= maxPeriod; period++) {
    const matched = periodicSuffixLength(seq, period, equals);
    const repeats = matched / period;
    if (repeats < minRepeatsFor(period)) continue;
    if (options.minDistinct !== undefined) {
      const unit = seq.slice(seq.length - period);
      const distinct = new Set(
        unit.map((item) => (options.keyOf ? options.keyOf(item) : (item as unknown as string))),
      ).size;
      if (distinct < options.minDistinct(period)) continue;
    }
    return { repeating: true, period, repeats };
  }
  return { repeating: false, period: null, repeats: 0 };
}
