import { describe, expect, test } from "bun:test";

import { classifyShellFileEvidence } from "./shell-evidence.js";

describe("classifyShellFileEvidence (CL-6937)", () => {
  test("in-place editors count as writes", () => {
    expect(classifyShellFileEvidence("sed -i '' 's/a/b/' src/a.ts").writes).toContain("src/a.ts");
    expect(classifyShellFileEvidence("perl -pi -e 's/a/b/' src/b.ts").writes).toContain("src/b.ts");
    expect(classifyShellFileEvidence("sed -i.bak 's/a/b/' src/c.ts").writes).toContain("src/c.ts");
  });

  test("sed without an in-place flag is a read, not a write", () => {
    const evidence = classifyShellFileEvidence("sed -n '1,20p' src/a.ts");
    expect(evidence.writes).toEqual([]);
    expect(evidence.reads).toContain("src/a.ts");
  });

  test("redirection is a write regardless of program", () => {
    expect(classifyShellFileEvidence("echo hi > out.txt").writes).toContain("out.txt");
    expect(classifyShellFileEvidence("printf x >> out.txt").writes).toContain("out.txt");
    expect(classifyShellFileEvidence("cat <<'EOF' > gen.ts\nx\nEOF").writes).toContain("gen.ts");
  });

  test("readers count as reads with their file operand", () => {
    expect(classifyShellFileEvidence("cat src/a.ts").reads).toContain("src/a.ts");
    expect(classifyShellFileEvidence("head -n 5 src/a.ts").reads).toContain("src/a.ts");
    expect(classifyShellFileEvidence("grep needle src/a.ts").reads).toContain("src/a.ts");
  });

  test("a reader with no file operand still records evidence keyed by program", () => {
    expect(classifyShellFileEvidence("git status | cat").reads).toContain("shell:cat");
  });

  test("wrapped payloads are inspected, not trusted", () => {
    expect(classifyShellFileEvidence("bash -c \"sed -i '' s/a/b/ src/a.ts\"").writes).toContain(
      "src/a.ts",
    );
  });

  test("chained commands contribute both sides", () => {
    const evidence = classifyShellFileEvidence("cat src/a.ts && tee src/b.ts < src/a.ts");
    expect(evidence.reads).toContain("src/a.ts");
    expect(evidence.writes).toContain("src/b.ts");
  });

  test("commands that touch no files yield nothing", () => {
    const evidence = classifyShellFileEvidence("bun run check");
    expect(evidence.reads).toEqual([]);
    expect(evidence.writes).toEqual([]);
  });
});
