import { describe, expect, test } from "bun:test";
import {
  claudeRow,
  defaultRow,
  FAMILY_IDS,
  FAMILY_ROWS,
  gptRow,
  grokRow,
  museRow,
  type PromptVarianceFamily,
} from "./rows.js";

describe("prompt-variance family rows", () => {
  test("ships exactly the default/muse/grok/claude/gpt families", () => {
    expect([...FAMILY_IDS]).toEqual([
      "default",
      "muse",
      "grok",
      "claude",
      "gpt",
    ]);
  });

  test("has no glm row until its eval lands (CL-8265)", () => {
    for (const id of FAMILY_IDS) {
      expect(id).not.toBe("glm");
    }
  });

  test("every row carries the id/residual shape — residuals-only, no deny fields", () => {
    for (const row of [defaultRow, museRow, grokRow, claudeRow, gptRow]) {
      expect(typeof row.id).toBe("string");
      expect(typeof row.residual).toBe("string");
      expect("advertisedToolDeny" in row).toBe(false);
      expect("sectionOmit" in row).toBe(false);
      expect("overrides" in row).toBe(false);
    }
  });

  test("row ids match their family and FAMILY_ROWS covers all five", () => {
    const ids: PromptVarianceFamily[] = [
      defaultRow.id,
      museRow.id,
      grokRow.id,
      claudeRow.id,
      gptRow.id,
    ];
    expect(ids).toEqual(["default", "muse", "grok", "claude", "gpt"]);
    expect(Object.keys(FAMILY_ROWS).sort()).toEqual([
      "claude",
      "default",
      "gpt",
      "grok",
      "muse",
    ]);
  });
});
