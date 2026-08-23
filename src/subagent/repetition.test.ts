import { describe, expect, test } from "bun:test";

import { appendCycleText, CYCLE_TEXT_CAP_CHARS } from "../session/stream-journal.js";
import {
  detectRepetition,
  DEFAULT_CONTENTLESS_GROWTH_CONFIG,
  DEFAULT_REPETITION_CONFIG,
  DEFAULT_TEXT_FOLDED_REPETITION_CONFIG,
  DEFAULT_THINKING_REPETITION_CONFIG,
  INITIAL_CONTENTLESS_GROWTH_STATE,
  REPETITION_CHECK_INTERVAL_CHARS,
  trackContentlessGrowth,
  type ContentlessGrowthState,
} from "./repetition.js";

// A monotonic counter that never repeats verbatim: each pair's numerator and
// denominator both grow, so raw text is never byte-periodic (the shape that
// escaped detection live: ~64k thinking tokens of "0/1 1/2 2/3 …").
function monotonicCounterStream(pairs: number): string {
  return Array.from({ length: pairs }, (_, i) => `${i}/${i + 1} `).join("");
}

const LOOP_SENTENCE =
  "next: dig footer/chrome and module structure for plan. 0/1.0 done. 1 remaining. 1h left. 0 errors. ";

describe("detectRepetition", () => {
  test("flags a looped status sentence with an oscillating counter", () => {
    // Counters that flip between values keep the raw text periodic — the
    // period just spans one full oscillation (two sentences here), so hitting
    // the repeat threshold takes twice as many iterations.
    const iterations = Array.from({ length: 40 }, (_, i) =>
      LOOP_SENTENCE.replace("0/1.0", `${i % 2}/1.0`),
    );
    const text = `some earlier legitimate prose about the task. ${iterations.join("")}`;
    const hit = detectRepetition(text);
    expect(hit).not.toBeNull();
    expect(hit?.repeats).toBeGreaterThanOrEqual(DEFAULT_REPETITION_CONFIG.repeatThreshold);
    expect(hit?.window).toContain("dig footer/chrome");
  });

  test("does not flag a markdown table whose rows differ only in numbers", () => {
    const rows = Array.from(
      { length: 12 },
      (_, i) => `| 202${i} | ${i * 10} requests | ${i} errors |\n`,
    ).join("");
    const text = `Here is the yearly summary table:\n\n| Year | Volume | Errors |\n|---|---|---|\n${rows}`;
    expect(detectRepetition(text)).toBeNull();
  });

  test("does not flag a numbered list with same-shaped items differing only in digits", () => {
    const items = Array.from(
      { length: 10 },
      (_, i) => `${i + 1}. Ran batch ${i + 1} and verified ${i * 3} records migrated\n`,
    ).join("");
    expect(detectRepetition(`Migration progress:\n${items}`)).toBeNull();
  });

  test("does not flag ordinary prose", () => {
    const prose =
      "The compactor builds a call index today, but it maps call id to tool name " +
      "and path for stub rendering. Deduping superseded reads needs a new inverse " +
      "index from path to its reads, then keep the newest full read of a path and " +
      "stub the older ones. Error results are preserved verbatim so failures stay " +
      "diagnosable across a compaction boundary. ".repeat(4);
    // repeat(4) of a long paragraph is periodic, but the period (~340 chars)
    // times the repeat threshold exceeds the repeated span, so it must not fire.
    expect(detectRepetition(prose)).toBeNull();
  });

  test("does not flag short repeated tokens below the window size", () => {
    const text = `heading\n${"- item\n".repeat(40)}`;
    expect(detectRepetition(text)).toBeNull();
  });

  test("requires the full repeat threshold", () => {
    const text = LOOP_SENTENCE.repeat(DEFAULT_REPETITION_CONFIG.repeatThreshold - 1);
    expect(detectRepetition(text)).toBeNull();
    const looped = LOOP_SENTENCE.repeat(DEFAULT_REPETITION_CONFIG.repeatThreshold + 1);
    expect(detectRepetition(looped)).not.toBeNull();
  });

  test("flags a short-phrase loop (10-char unit, observed live)", () => {
    // The second captured incident: "Groaning. " emitted ~1,363 times. The
    // old 16-char window floor never saw a 10-char unit.
    const text = "Groaning. ".repeat(1300);
    const hit = detectRepetition(text);
    expect(hit).not.toBeNull();
    expect(hit?.window).toBe("Groaning. ");
    expect(hit?.repeats).toBeGreaterThanOrEqual(DEFAULT_REPETITION_CONFIG.repeatThreshold);
  });

  test("does not flag a repeated markdown table separator row", () => {
    const row = "| ---------------------- | ---------------------- |\n";
    expect(detectRepetition(`| Left | Right |\n${row.repeat(6)}`)).toBeNull();
  });

  test("does not flag a few identical code lines", () => {
    const line = "  const result = await fetchData(request, options, context)\n";
    expect(detectRepetition(line.repeat(3))).toBeNull();
  });

  test("returns null for text shorter than one full window set", () => {
    expect(detectRepetition("short")).toBeNull();
    expect(detectRepetition("")).toBeNull();
  });

  test("a strictly monotonic counter escapes the default (text) config even with thousands of tokens", () => {
    // Documents the known, deliberate limitation for visible text: a growing
    // counter is never byte-periodic, so it stays indistinguishable from a
    // legitimate numbered list without digit normalization.
    const text = monotonicCounterStream(4000);
    expect(detectRepetition(text)).toBeNull();
  });

  test("digit-normalized detection catches the monotonic counter (thinking-stream shape)", () => {
    const text = monotonicCounterStream(4000);
    const hit = detectRepetition(text, DEFAULT_THINKING_REPETITION_CONFIG, { normalizeDigits: true });
    expect(hit).not.toBeNull();
    expect(hit?.repeats).toBeGreaterThanOrEqual(DEFAULT_THINKING_REPETITION_CONFIG.repeatThreshold);
  });

  test("a healthy numbered list stays untripped under the default (text) config", () => {
    // The run loop never passes normalizeDigits for inference.text.delta —
    // this pins that visible text keeps the digit-preserving path regardless
    // of how many items stream.
    const items = Array.from(
      { length: 400 },
      (_, i) => `${i + 1}. Ran batch ${i + 1} and verified ${i * 3} records migrated\n`,
    ).join("");
    expect(detectRepetition(`Migration progress:\n${items}`)).toBeNull();
  });

  test("does not flag templated enumeration in thinking after digit folding", () => {
    // Regression: folding digits collapses a healthy templated line to a
    // byte-identical ~40+ char unit once its digits are erased. 200 lines
    // (~10KB) would trip windowMinChars 4 / repeatThreshold 32 without the
    // maxFoldedPeriodChars gate, aborting a healthy worker mid-reasoning.
    const items = Array.from(
      { length: 200 },
      (_, i) => `${i + 1}. Ran batch ${i + 1} and verified ${i * 3} records migrated\n`,
    ).join("");
    const hit = detectRepetition(items, DEFAULT_THINKING_REPETITION_CONFIG, {
      normalizeDigits: true,
    });
    expect(hit).toBeNull();
  });

  test("still catches the monotonic counter with thousands of pairs", () => {
    const text = monotonicCounterStream(4000);
    const hit = detectRepetition(text, DEFAULT_THINKING_REPETITION_CONFIG, { normalizeDigits: true });
    expect(hit).not.toBeNull();
    expect(hit?.repeats).toBeGreaterThanOrEqual(DEFAULT_THINKING_REPETITION_CONFIG.repeatThreshold);
  });

  test("a near-counter with a short prose wrapper still folds to a short period and trips", () => {
    // "step N/N done. " folds to "step 0/0 done. " — a 15-char period, still
    // within maxFoldedPeriodChars (16), so this shape is (deliberately) still
    // caught: it reads as a stalled step counter, not templated enumeration.
    const text = Array.from({ length: 100 }, (_, i) => `step ${i}/${i + 1} done. `).join("");
    const hit = detectRepetition(text, DEFAULT_THINKING_REPETITION_CONFIG, { normalizeDigits: true });
    expect(hit).not.toBeNull();
  });
});

describe("repetition check accounting at the cycle-text cap", () => {
  test("token-based accounting keeps checking after the buffer is capped", () => {
    // Mirrors the sub-agent streamSink: the counter must accumulate raw token
    // length, because at the cap the buffer length stops growing and a
    // growth-based counter would disarm detection for the rest of the turn.
    let text = "x".repeat(CYCLE_TEXT_CAP_CHARS);
    let charsSinceCheck = 0;
    let checks = 0;
    let hit = null;
    for (let i = 0; i < 200; i++) {
      text = appendCycleText(text, LOOP_SENTENCE);
      charsSinceCheck += LOOP_SENTENCE.length;
      if (charsSinceCheck >= REPETITION_CHECK_INTERVAL_CHARS) {
        charsSinceCheck = 0;
        checks++;
        hit = hit ?? detectRepetition(text);
      }
    }
    expect(checks).toBeGreaterThan(0);
    expect(hit).not.toBeNull();
  });
});


  test("flags a loop that injects zero-width spaces between identical windows", () => {
    // Without format-char stripping, ZWSP breaks byte periodicity and the
    // detector misses the loop (observed in live thrash fleets).
    const window = "I'll open the remaining source files and implement the activity preview. ";
    const zwsp = "\u200B";
    const text = (window + zwsp).repeat(20);
    const hit = detectRepetition(text);
    expect(hit).not.toBeNull();
    expect(hit?.repeats).toBeGreaterThanOrEqual(DEFAULT_REPETITION_CONFIG.repeatThreshold);
  });

describe("folded text pass (DEFAULT_TEXT_FOLDED_REPETITION_CONFIG)", () => {
  // Mirrors run.ts: digit-preserving default first, capped folded pass second.
  function detectText(text: string) {
    return (
      detectRepetition(text) ??
      detectRepetition(text, DEFAULT_TEXT_FOLDED_REPETITION_CONFIG, { normalizeDigits: true })
    );
  }

  test("flags an incrementing counter flood in visible text", () => {
    // Observed live: "14279 14280 14281…" streamed to inference-error.
    const text = Array.from({ length: 500 }, (_, i) => `${14279 + i} `).join("");
    expect(detectRepetition(text)).toBeNull();
    expect(detectText(text)).not.toBeNull();
  });

  test("flags an incrementing pair-counter flood", () => {
    // Observed live: "5620/5620. 5621/5621. …"
    const text = Array.from({ length: 300 }, (_, i) => `${5620 + i}/${5620 + i}. `).join("");
    expect(detectText(text)).not.toBeNull();
  });

  test("flags a repeated-timestamp flood", () => {
    // Observed live: "18:22:27." emitted hundreds of times, with drift.
    const text = Array.from({ length: 300 }, (_, i) => `18:22:${27 + (i % 30)}. `).join("");
    expect(detectText(text)).not.toBeNull();
  });

  test("flags a zero-percent flood", () => {
    // "0% " is a 3-char unit — under the plain 8-char window floor.
    const text = "0% ".repeat(200);
    expect(detectRepetition(text)).toBeNull();
    expect(detectText(text)).not.toBeNull();
  });

  test("flags fence and brace floods", () => {
    expect(detectText("```\n".repeat(100))).not.toBeNull();
    expect(detectText("}\n".repeat(200))).not.toBeNull();
  });

  test("flags an emoji flood (surrogate-pair unit)", () => {
    // Observed live: "🤔 " ×~40K chars. The unit is 3 UTF-16 units; the
    // code-point reversal must keep the pair intact for it to stay periodic.
    const text = "🤔 ".repeat(2000);
    expect(detectText(text)).not.toBeNull();
  });

  test("does not flag a numbered list under the folded text pass", () => {
    // Folds to a ~47-char period — refused by maxFoldedPeriodChars.
    const items = Array.from(
      { length: 400 },
      (_, i) => `${i + 1}. Ran batch ${i + 1} and verified ${i * 3} records migrated\n`,
    ).join("");
    expect(detectText(`Migration progress:\n${items}`)).toBeNull();
  });

  test("does not flag a digit-varying markdown table under the folded text pass", () => {
    const rows = Array.from(
      { length: 40 },
      (_, i) => `| 202${i % 10} | ${i * 10} requests | ${i} errors |\n`,
    ).join("");
    expect(detectText(`| Year | Volume | Errors |\n|---|---|---|\n${rows}`)).toBeNull();
  });

  test("a short user-requested enumeration stays under the folded repeat bar", () => {
    // "print 1..40" folds to "0 " ×40 — under repeatThreshold 64.
    const text = Array.from({ length: 40 }, (_, i) => `${i + 1} `).join("");
    expect(detectText(text)).toBeNull();
  });
});

describe("trackContentlessGrowth", () => {
  function feed(tokens: readonly string[]): boolean {
    let state: ContentlessGrowthState = INITIAL_CONTENTLESS_GROWTH_STATE;
    for (const token of tokens) {
      const next = trackContentlessGrowth(state, token);
      if (next.hit) return true;
      state = next.state;
    }
    return false;
  }

  test("flags a zero-width flood (ZWNJ/ZWJ walls, observed live)", () => {
    // Observed live: 500–53,000 U+200C/U+200D chars per stream.
    // detectRepetition strips invisibles before checking, so it must not be
    // the only line of defense.
    const flood = Array.from({ length: 60 }, () => "‌‍".repeat(32));
    expect(detectRepetition(flood.join(""))).toBeNull();
    expect(feed(flood)).toBe(true);
  });

  test("flags a flood even when prefixed by healthy prose", () => {
    const tokens = [
      "Let me look at the config first. ".repeat(4),
      ...Array.from({ length: 100 }, () => "‍".repeat(64)),
    ];
    expect(feed(tokens)).toBe(true);
  });

  test("does not flag ordinary prose or sparse code", () => {
    const tokens = Array.from(
      { length: 200 },
      (_, i) => `  const value${i} = await compute(input${i});\n\n`,
    );
    expect(feed(tokens)).toBe(false);
  });

  test("a visible-rich window re-arms rather than latching", () => {
    // Enough visible content inside every window keeps the guard quiet no
    // matter how long the stream runs.
    const tokens = Array.from({ length: 50 }, () =>
      `${"‌".repeat(100)} some genuinely visible sentence with plenty of characters. `,
    );
    expect(feed(tokens)).toBe(false);
  });

  test("whitespace does not count as visible content", () => {
    const raw = " \n\t".repeat(DEFAULT_CONTENTLESS_GROWTH_CONFIG.rawWindowChars);
    expect(feed([raw])).toBe(true);
  });
});

describe("appendCycleText", () => {
  test("keeps only the tail past the cap", () => {
    const text = appendCycleText("a".repeat(10), "b".repeat(10), 15);
    expect(text).toHaveLength(15);
    expect(text.endsWith("b".repeat(10))).toBe(true);
  });

  test("appends unchanged under the cap", () => {
    expect(appendCycleText("abc", "def", 100)).toBe("abcdef");
  });
});
