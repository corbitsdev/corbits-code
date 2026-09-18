import { describe, expect, test } from "bun:test";
import { assemble } from "./assemble.js";
import { defaultRow, grokRow, museRow } from "./rows.js";

// CL-8269 RED: assemble does not exist yet — every test below fails until
// the GREEN lands packages/prompt-variance.

const SECTIONS = ["contract", "Tools (names only): read_file", "context"];
const TOOLS = ["read_file", "skill_search", "use_skill", "run_shell"];

describe("assemble", () => {
  test("joins sections with the residual as the last section", () => {
    const out = assemble(SECTIONS, grokRow, TOOLS);
    expect(out.systemPrompt).toContain("contract");
    expect(out.systemPrompt.trimEnd().endsWith(grokRow.residual)).toBe(true);
  });

  test("a row without residual leaves the sections unchanged", () => {
    const out = assemble(SECTIONS, defaultRow, TOOLS);
    expect(out.systemPrompt).toBe(SECTIONS.join("\n\n"));
  });

  test("muse residual closes the prompt like the shipped tail append", () => {
    const out = assemble(SECTIONS, museRow, TOOLS);
    expect(out.systemPrompt.trimEnd().endsWith(museRow.residual)).toBe(true);
  });

  test("filters advertisedToolDeny from the tool names, preserving order", () => {
    const out = assemble(SECTIONS, grokRow, TOOLS);
    expect([...out.toolNames]).toEqual(["read_file", "use_skill", "run_shell"]);
  });

  test("variance cannot grant tools: output is always a subset of the input", () => {
    for (const row of [defaultRow, museRow, grokRow]) {
      const out = assemble(SECTIONS, row, TOOLS);
      for (const name of out.toolNames) {
        expect(TOOLS).toContain(name);
      }
      expect(out.toolNames.length).toBeLessThanOrEqual(TOOLS.length);
    }
  });

  test("variance cannot grant tools: unknown mounted names pass through untouched", () => {
    const out = assemble(SECTIONS, defaultRow, ["alpha", "beta"]);
    expect([...out.toolNames]).toEqual(["alpha", "beta"]);
  });

  test("refuses a row that denies use_skill", () => {
    const bad = { ...grokRow, advertisedToolDeny: ["use_skill"] };
    expect(() => assemble(SECTIONS, bad, TOOLS)).toThrow(/use_skill/);
  });
});
