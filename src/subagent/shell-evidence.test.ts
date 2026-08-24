import { describe, expect, test } from "bun:test";

import { classifyShellFileEvidence } from "./shell-evidence.js";

describe("classifyShellFileEvidence (CL-6937)", () => {
  test("readers count as reads with their file operand", () => {
    expect(classifyShellFileEvidence("cat src/a.ts").reads).toContain("src/a.ts");
    expect(classifyShellFileEvidence("head -n 5 src/a.ts").reads).toContain("src/a.ts");
    expect(classifyShellFileEvidence("grep needle src/a.ts").reads).toContain("src/a.ts");
  });

  test("a reader with no file operand still records evidence keyed by program", () => {
    expect(classifyShellFileEvidence("git status | cat").reads).toContain("shell:cat");
  });

  test("wrapped payloads are inspected, not trusted", () => {
    expect(classifyShellFileEvidence('bash -c "cat src/a.ts"').reads).toContain("src/a.ts");
  });

  test("chained commands contribute reads from every segment", () => {
    const evidence = classifyShellFileEvidence("cat src/a.ts && grep needle src/b.ts");
    expect(evidence.reads).toContain("src/a.ts");
    expect(evidence.reads).toContain("src/b.ts");
  });

  test("commands that touch no files yield nothing", () => {
    const evidence = classifyShellFileEvidence("bun run check");
    expect(evidence.reads).toEqual([]);
  });
});
