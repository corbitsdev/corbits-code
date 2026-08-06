/**
 * Reasoning chrome: the one live line a chain of thought occupies while it
 * streams, and the phrase it settles to once it is done.
 *
 * Reasoning is not the answer, so it never gets to own the screen. While it
 * arrives it rides a single row whose window follows the newest text; once the
 * turn moves on it collapses to a phrase and its elapsed time, with the full
 * text one keypress away.
 */

/** What a settled reasoning row remembers about the thinking it replaced. */
export type Thought = {
  /** Wall time the reasoning took, in milliseconds. */
  readonly ms: number
  /**
   * Rotating index into the phrase set for the row's time band. Carried on the
   * row rather than derived from the text so two thoughts of the same length in
   * one session do not read back identically.
   */
  readonly variant: number
}

/**
 * Live reasoning as one row: whitespace flattened, windowed onto the newest
 * text. Content arrival is what moves the window, so the line is alive exactly
 * while tokens are — it needs no clock of its own and cannot outlive the turn.
 */
export function thinkingScrollLine(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ").trimStart()
  const columns = Math.max(1, Math.floor(width))
  if (flat.length <= columns) return flat
  return flat.slice(flat.length - columns)
}

/** Wording for a duration, rounded to the unit a reader would actually say. */
function humanDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`
  const minutes = Math.round(seconds / 60)
  if (minutes <= 1) return "a minute"
  if (minutes === 2) return "a couple of minutes"
  return `${minutes} minutes`
}

/**
 * Phrase sets by elapsed band. Every phrase reports only that time passed and
 * that reasoning happened — none of them claims a result, because the row is
 * written before anyone knows whether the thinking was any good.
 */
const PHRASE_BANDS: readonly {
  readonly underMs: number
  readonly phrases: readonly string[]
}[] = [
  {
    underMs: 2_000,
    phrases: ["thought for a moment", "a quick thought", "barely paused"],
  },
  {
    underMs: 10_000,
    phrases: [
      "thought for {duration}",
      "mulled it over for {duration}",
      "chewed on it for {duration}",
    ],
  },
  {
    underMs: 45_000,
    phrases: [
      "thought it through for {duration}",
      "weighed it for {duration}",
      "worked through it for {duration}",
    ],
  },
  {
    underMs: 180_000,
    phrases: [
      "tinkered for {duration}",
      "turned it over for {duration}",
      "sat with it for {duration}",
    ],
  },
  {
    underMs: Number.POSITIVE_INFINITY,
    phrases: [
      "went deep for {duration}",
      "took the long way round — {duration}",
      "spent {duration} on this",
    ],
  },
]

/** The settled one-line summary for a thought of `ms`, varied by `variant`. */
export function thoughtPhrase(ms: number, variant: number): string {
  const band =
    PHRASE_BANDS.find((candidate) => ms < candidate.underMs) ??
    PHRASE_BANDS[PHRASE_BANDS.length - 1]
  const phrases = band?.phrases ?? ["thought for {duration}"]
  const index = ((Math.trunc(variant) % phrases.length) + phrases.length) % phrases.length
  const phrase = phrases[index] ?? phrases[0] ?? "thought for {duration}"
  return phrase.replace("{duration}", humanDuration(ms))
}
