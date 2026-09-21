import { describe, expect, test } from "bun:test";
import {
  claudeRow,
  defaultRow,
  FAMILY_IDS,
  FAMILY_ROWS,
  gptRow,
  grokRow,
  grokToolBudgetResidual,
  museRow,
  type PromptVarianceFamily,
} from "./rows.js";

const CEREMONY_LINES = [
  "Never run git add, git commit, git stash, or any other state-changing git command unless the user asks.",
  "Do not narrate a plan before acting on a small task; act, then report.",
  "Verify with the test command once at the end, not after every edit.",
];

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

  test("muse row is the shipped CL-7869 tool-discipline text", () => {
    expect(museRow.residual).toContain("Tool discipline:");
    expect(museRow.residual).toContain("Batch independent tool calls");
    expect(museRow.residual).toContain("Never re-read a file");
    expect(museRow.residual).toContain("Do not narrate; act.");
  });

  test("grok row is the single finish-bias + ceremony block (CL-8296)", () => {
    expect(grokRow.residual).toContain("Finish bias (xAI / Grok worker):");
    expect(grokRow.residual).toContain("prefer the structured report");
    expect(grokRow.residual).toContain("re-open paths you already read");
    expect(grokRow.residual).toContain("done-definition is met");
    expect(grokRow.residual).toContain("never run_shell");
  });

  test("each ceremony line appears exactly once in the grok row (P2 invariant)", () => {
    for (const line of CEREMONY_LINES) {
      const occurrences = grokRow.residual.split(line).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  test("grok tool-budget residual is ceremony-free and budget text appears once (P1 invariant)", () => {
    expect(grokToolBudgetResidual).toContain("Tool budget:");
    for (const line of CEREMONY_LINES) {
      expect(grokToolBudgetResidual).not.toContain(line);
    }
    const budgetOccurrences =
      grokToolBudgetResidual.split("Tool budget:").length - 1;
    expect(budgetOccurrences).toBe(1);
  });

  test("default row carries no residual", () => {
    expect(defaultRow.residual).toBe("");
  });

  test("claude row is the single XML task_guidance block (CL-8309)", () => {
    expect(claudeRow.residual).toContain("<task_guidance>");
    expect(claudeRow.residual).toContain("</task_guidance>");
    expect(claudeRow.residual).toContain("Follow the dispatch brief exactly");
    expect(claudeRow.residual).toContain("Batch independent tool calls");
  });

  test("gpt row is the narrate-before-tools nudge (CL-8310)", () => {
    expect(gptRow.residual).toContain("Narrate before tools (GPT worker):");
    expect(gptRow.residual).toContain(
      "one short line saying what you are doing",
    );
    expect(gptRow.residual).toContain("done-definition is met");
  });
});
