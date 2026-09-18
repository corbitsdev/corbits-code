import { describe, expect, test } from "bun:test";
import {
  defaultRow,
  FAMILY_IDS,
  grokRow,
  museRow,
  type PromptVarianceFamily,
} from "./rows.js";

// CL-8269 RED: the versioned prompt-variance package does not exist yet, so
// every test below fails at import time until the GREEN lands it.

describe("prompt-variance family rows", () => {
  test("ships exactly the default/muse/grok families", () => {
    expect([...FAMILY_IDS]).toEqual(["default", "muse", "grok"]);
  });

  test("has no glm/claude/gpt rows until their evals land (CL-8265/7772/7775)", () => {
    for (const id of FAMILY_IDS) {
      expect(["glm", "claude", "gpt"]).not.toContain(id);
    }
  });

  test("every row carries the render/residual/deny/omit shape", () => {
    for (const row of [defaultRow, museRow, grokRow]) {
      expect(row.render).toBe("tail");
      expect(typeof row.residual).toBe("string");
      expect(Array.isArray([...row.advertisedToolDeny])).toBe(true);
      expect(Array.isArray([...row.sectionOmit])).toBe(true);
    }
  });

  test("row ids match their family", () => {
    const ids: PromptVarianceFamily[] = [
      defaultRow.id,
      museRow.id,
      grokRow.id,
    ];
    expect(ids).toEqual(["default", "muse", "grok"]);
  });

  test("muse row is the shipped CL-7869 tool-discipline text", () => {
    expect(museRow.residual).toContain("Tool discipline:");
    expect(museRow.residual).toContain("Batch independent tool calls");
    expect(museRow.residual).toContain("Never re-read a file");
    expect(museRow.residual).toContain("Do not narrate; act.");
  });

  test("grok row is the existing finish-bias residual", () => {
    expect(grokRow.residual).toContain("Finish bias (xAI / Grok worker):");
    expect(grokRow.residual).toContain("prefer the structured report");
    expect(grokRow.residual).toContain("re-open paths you already read");
    expect(grokRow.residual).toContain("done-definition is met");
    expect(grokRow.residual).toContain("never run_shell");
  });

  test("default row carries no residual", () => {
    expect(defaultRow.residual).toBe("");
  });

  test("grok leaves deny skill_search only; other rows deny nothing", () => {
    expect([...grokRow.advertisedToolDeny]).toEqual(["skill_search"]);
    expect([...defaultRow.advertisedToolDeny]).toEqual([]);
    expect([...museRow.advertisedToolDeny]).toEqual([]);
  });

  test("no row denies use_skill — brief-named skills always load directly", () => {
    for (const row of [defaultRow, museRow, grokRow]) {
      expect(row.advertisedToolDeny).not.toContain("use_skill");
    }
  });

  test("sectionOmit starts empty on every row", () => {
    for (const row of [defaultRow, museRow, grokRow]) {
      expect([...row.sectionOmit]).toEqual([]);
    }
  });
});
