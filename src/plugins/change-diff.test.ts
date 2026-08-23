import { describe, expect, test } from "bun:test";
import { formatChangeDiff, MAX_DIFF_CHARS } from "./change-diff.js";

describe("formatChangeDiff", () => {
  test("returns undefined when content is unchanged", () => {
    expect(formatChangeDiff("a.txt", "same\n", "same\n")).toBeUndefined();
  });

  test("small edit produces a unified diff with context", () => {
    const before = "line1\nline2\nline3\nline4\nline5\n";
    const after = "line1\nline2\nCHANGED\nline4\nline5\n";

    const diff = formatChangeDiff("a.txt", before, after);

    expect(diff).toBeDefined();
    expect(diff).toContain("--- a.txt");
    expect(diff).toContain("+++ a.txt");
    expect(diff).toContain("-line3");
    expect(diff).toContain("+CHANGED");
    expect(diff).toContain(" line2");
    expect(diff).toContain(" line4");
  });

  test("whole-file rewrite is bounded by the char cap and says so", () => {
    const before = "old content\n".repeat(2000);
    const after = "new content\n".repeat(2000);

    const diff = formatChangeDiff("a.txt", before, after);

    expect(diff).toBeDefined();
    // The cap must hold exactly — the truncation note is reserved WITHIN
    // maxChars, not appended after it.
    expect(diff!.length).toBeLessThanOrEqual(MAX_DIFF_CHARS);
    expect(diff).toContain("truncated");
  });

  test("truncation note never pushes the result past the cap at a small boundary", () => {
    // A tiny maxChars stresses the fixed-point loop in truncate(): the note's
    // own length (which depends on the digit counts it reports) must still
    // fit within the cap it is describing.
    const before = "a\n".repeat(50);
    const after = "b\n".repeat(50);

    for (const maxChars of [50, 80, 120, 200]) {
      const diff = formatChangeDiff("a.txt", before, after, maxChars);
      expect(diff).toBeDefined();
      expect(diff!.length).toBeLessThanOrEqual(maxChars);
    }
  });

  test("very large files skip full LCS and report a bounded summary", () => {
    const before = Array.from({ length: 3000 }, (_, i) => `l${i}`).join("\n");
    const after = Array.from({ length: 3000 }, (_, i) => `m${i}`).join("\n");

    const diff = formatChangeDiff("big.txt", before, after);

    expect(diff).toBeDefined();
    expect(diff).toContain("large change");
    expect(diff).toContain("exceeds");
    expect(diff!.length).toBeLessThanOrEqual(MAX_DIFF_CHARS);
  });

  test("deletion (after is empty) shows removed lines", () => {
    const diff = formatChangeDiff("gone.txt", "keep me\n", "");
    expect(diff).toBeDefined();
    expect(diff).toContain("-keep me");
  });
});
