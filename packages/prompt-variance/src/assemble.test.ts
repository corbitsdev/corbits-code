import { describe, expect, test } from "bun:test";
import { assemble } from "./assemble.js";
import { claudeRow, defaultRow, gptRow, grokRow, museRow } from "./rows.js";

const SECTIONS = ["contract", "Tools (names only): read_file", "context"];

describe("assemble", () => {
  test("joins sections with the residual as the last section", () => {
    const out = assemble(SECTIONS, grokRow);
    expect(out).toContain("contract");
    expect(out.trimEnd().endsWith(grokRow.residual)).toBe(true);
  });

  test("a row without residual leaves the sections unchanged", () => {
    expect(assemble(SECTIONS, defaultRow)).toBe(SECTIONS.join("\n\n"));
  });

  test("muse residual closes the prompt like the shipped tail append", () => {
    const out = assemble(SECTIONS, museRow);
    expect(out.trimEnd().endsWith(museRow.residual)).toBe(true);
  });

  test("claude and gpt residuals close the prompt the same way", () => {
    expect(
      assemble(SECTIONS, claudeRow).trimEnd().endsWith(claudeRow.residual),
    ).toBe(true);
    expect(assemble(SECTIONS, gptRow).trimEnd().endsWith(gptRow.residual)).toBe(
      true,
    );
  });

  test("tool mounting is out of scope: assemble returns a string, not tool names", () => {
    const out = assemble(SECTIONS, grokRow);
    expect(typeof out).toBe("string");
  });
});
