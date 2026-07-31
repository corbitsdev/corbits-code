import { describe, expect, test } from "bun:test";

import {
  appendCycleText,
  detectRepetition,
  DEFAULT_REPETITION_CONFIG,
} from "./repetition.js";

const LOOP_SENTENCE =
  "next: dig footer/chrome and module structure for plan. 0/1.0 done. 1 remaining. 1h left. 0 errors. ";

describe("detectRepetition", () => {
  test("flags a looped status sentence with flipping counters", () => {
    const iterations = Array.from({ length: 10 }, (_, i) =>
      LOOP_SENTENCE.replace("0/1.0", `${i % 2}/1.0`),
    );
    const text = `some earlier legitimate prose about the task. ${iterations.join("")}`;
    const hit = detectRepetition(text);
    expect(hit).not.toBeNull();
    expect(hit?.repeats).toBeGreaterThanOrEqual(DEFAULT_REPETITION_CONFIG.repeatThreshold);
    expect(hit?.window).toContain("dig footer/chrome");
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
