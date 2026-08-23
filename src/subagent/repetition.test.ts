import { describe, expect, test } from "bun:test";

import { appendCycleText, CYCLE_TEXT_CAP_CHARS } from "../session/stream-journal.js";
import {
  detectRepetition,
  DEFAULT_REPETITION_CONFIG,
  DEFAULT_THINKING_REPETITION_CONFIG,
  REPETITION_CHECK_INTERVAL_CHARS,
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
    // period just spans one full oscillation (two sentences here).
    const iterations = Array.from({ length: 20 }, (_, i) =>
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
    const hit = detectRepetition(text, DEFAULT_THINKING_REPETITION_CONFIG, {
      normalizeDigits: true,
    });
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
    const hit = detectRepetition(text, DEFAULT_THINKING_REPETITION_CONFIG, {
      normalizeDigits: true,
    });
    expect(hit).not.toBeNull();
    expect(hit?.repeats).toBeGreaterThanOrEqual(DEFAULT_THINKING_REPETITION_CONFIG.repeatThreshold);
  });

  test("a near-counter with a short prose wrapper still folds to a short period and trips", () => {
    // "step N/N done. " folds to "step 0/0 done. " — a 15-char period, still
    // within maxFoldedPeriodChars (16), so this shape is (deliberately) still
    // caught: it reads as a stalled step counter, not templated enumeration.
    const text = Array.from({ length: 100 }, (_, i) => `step ${i}/${i + 1} done. `).join("");
    const hit = detectRepetition(text, DEFAULT_THINKING_REPETITION_CONFIG, {
      normalizeDigits: true,
    });
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
  const text = (window + zwsp).repeat(12);
  const hit = detectRepetition(text);
  expect(hit).not.toBeNull();
  expect(hit?.repeats).toBeGreaterThanOrEqual(DEFAULT_REPETITION_CONFIG.repeatThreshold);
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
