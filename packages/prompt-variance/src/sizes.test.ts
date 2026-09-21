import { describe, expect, test } from "bun:test";
import { claudeRow, defaultRow, gptRow, grokRow, museRow } from "./rows.js";

describe("prompt-variance prompt sizes per family row", () => {
  test("default residual is empty", () => {
    expect(defaultRow.residual.length).toBe(0);
  });

  test("every tuned residual stays under 2000 chars / 3000 bytes", () => {
    for (const row of [museRow, grokRow, claudeRow, gptRow]) {
      expect(row.residual.length).toBeGreaterThan(0);
      expect(row.residual.length).toBeLessThan(2000);
      expect(Buffer.byteLength(row.residual, "utf8")).toBeLessThan(3000);
    }
  });

  test("the grok finish-bias residual is larger than the muse discipline rules", () => {
    expect(grokRow.residual.length).toBeGreaterThan(museRow.residual.length);
  });
});
