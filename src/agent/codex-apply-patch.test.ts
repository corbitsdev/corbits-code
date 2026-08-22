import { describe, expect, test } from "bun:test";
import {
  CodexApplyPatchError,
  applyUpdateHunks,
  extractAffectedPaths,
  parseCodexApplyPatch,
} from "./codex-apply-patch.js";

describe("parseCodexApplyPatch", () => {
  test("parses Add File with Codex trailing newlines", () => {
    const patch = parseCodexApplyPatch(`*** Begin Patch
*** Add File: hello.txt
+Hello world
+second line
*** End Patch
`);
    expect(patch.ops).toEqual([
      {
        type: "add",
        path: "hello.txt",
        content: "Hello world\nsecond line\n",
      },
    ]);
  });

  test("Add File with no + lines yields empty content", () => {
    const patch = parseCodexApplyPatch(`*** Begin Patch
*** Add File: empty.txt
*** End Patch
`);
    expect(patch.ops).toEqual([{ type: "add", path: "empty.txt", content: "" }]);
  });

  test("parses Delete File", () => {
    const patch = parseCodexApplyPatch(`*** Begin Patch
*** Delete File: obsolete.txt
*** End Patch
`);
    expect(patch.ops).toEqual([{ type: "delete", path: "obsolete.txt" }]);
  });

  test("parses Update File with Move to", () => {
    const patch = parseCodexApplyPatch(`*** Begin Patch
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** End Patch
`);
    expect(patch.ops).toHaveLength(1);
    const op = patch.ops[0]!;
    expect(op.type).toBe("update");
    if (op.type !== "update") throw new Error("unreachable");
    expect(op.path).toBe("src/app.py");
    expect(op.moveTo).toBe("src/main.py");
    expect(op.hunks).toHaveLength(1);
    expect(op.hunks[0]!.header).toBe("def greet():");
    expect(op.hunks[0]!.lines).toEqual([
      { kind: "-", text: 'print("Hi")' },
      { kind: "+", text: 'print("Hello, world!")' },
    ]);
  });

  test("parses stacked multi-@@ context anchors as header-only then change hunk", () => {
    const patch = parseCodexApplyPatch(`*** Begin Patch
*** Update File: src/app.py
@@ class BaseClass
@@     def method():
-old_line
+new_line
*** End Patch
`);
    const op = patch.ops[0]!;
    expect(op.type).toBe("update");
    if (op.type !== "update") throw new Error("unreachable");
    expect(op.hunks).toHaveLength(2);
    expect(op.hunks[0]).toEqual({ header: "class BaseClass", lines: [] });
    expect(op.hunks[1]!.header).toBe("    def method():");
    expect(op.hunks[1]!.lines).toEqual([
      { kind: "-", text: "old_line" },
      { kind: "+", text: "new_line" },
    ]);
  });

  test("rejects bare empty @@ without lines", () => {
    expect(() =>
      parseCodexApplyPatch(`*** Begin Patch
*** Update File: src/app.py
@@
*** End Patch
`),
    ).toThrow(/empty hunk/);
  });

  test("rejects malformed envelope (missing Begin)", () => {
    expect(() =>
      parseCodexApplyPatch(`*** Add File: a.txt
+hi
*** End Patch
`),
    ).toThrow(CodexApplyPatchError);
    expect(() =>
      parseCodexApplyPatch(`*** Add File: a.txt
+hi
*** End Patch
`),
    ).toThrow(/Begin Patch/);
  });

  test("rejects malformed envelope (missing End)", () => {
    expect(() =>
      parseCodexApplyPatch(`*** Begin Patch
*** Add File: a.txt
+hi
`),
    ).toThrow(/End Patch/);
  });

  test("rejects absolute paths", () => {
    expect(() =>
      parseCodexApplyPatch(`*** Begin Patch
*** Add File: /etc/passwd
+x
*** End Patch
`),
    ).toThrow(/relative/);

    expect(() =>
      parseCodexApplyPatch(`*** Begin Patch
*** Delete File: /tmp/x
*** End Patch
`),
    ).toThrow(/absolute/);

    expect(() =>
      parseCodexApplyPatch(`*** Begin Patch
*** Update File: C:\\Windows\\system32\\x
@@
-a
+b
*** End Patch
`),
    ).toThrow(/absolute/);
  });
});

describe("extractAffectedPaths", () => {
  test("multi-file path extraction", () => {
    const patch = parseCodexApplyPatch(`*** Begin Patch
*** Add File: hello.txt
+Hello
*** Update File: src/app.py
@@
-old
+new
*** Delete File: obsolete.txt
*** End Patch
`);
    expect(extractAffectedPaths(patch)).toEqual([
      "hello.txt",
      "src/app.py",
      "obsolete.txt",
    ]);
  });

  test("move path extraction includes source and destination", () => {
    const patch = parseCodexApplyPatch(`*** Begin Patch
*** Update File: src/app.py
*** Move to: src/main.py
@@
-a
+b
*** End Patch
`);
    expect(extractAffectedPaths(patch)).toEqual(["src/app.py", "src/main.py"]);
  });
});

describe("applyUpdateHunks", () => {
  test("applies a simple replacement hunk", () => {
    const original = `def greet():
print("Hi")
print("bye")
`;
    const patch = parseCodexApplyPatch(`*** Begin Patch
*** Update File: src/app.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** End Patch
`);
    const op = patch.ops[0]!;
    expect(op.type).toBe("update");
    if (op.type !== "update") throw new Error("unreachable");
    const updated = applyUpdateHunks(original, op.hunks);
    expect(updated).toBe(`def greet():
print("Hello, world!")
print("bye")
`);
  });

  test("applies stacked multi-@@ anchors then replacement", () => {
    const original = `class BaseClass
    def method():
        old_line
        keep
`;
    const patch = parseCodexApplyPatch(`*** Begin Patch
*** Update File: src/app.py
@@ class BaseClass
@@     def method():
-        old_line
+        new_line
*** End Patch
`);
    const op = patch.ops[0]!;
    expect(op.type).toBe("update");
    if (op.type !== "update") throw new Error("unreachable");
    expect(applyUpdateHunks(original, op.hunks)).toBe(`class BaseClass
    def method():
        new_line
        keep
`);
  });

  test("applies context-aware multi-line hunk", () => {
    const original = `line1
line2
target
line4
`;
    const hunks = [
      {
        lines: [
          { kind: " " as const, text: "line2" },
          { kind: "-" as const, text: "target" },
          { kind: "+" as const, text: "replaced" },
          { kind: " " as const, text: "line4" },
        ],
      },
    ];
    expect(applyUpdateHunks(original, hunks)).toBe(`line1
line2
replaced
line4
`);
  });

  test("fuzzy match: rstrip then trim after exact fail", () => {
    const original = `foo
bar  
baz
`;
    const updated = applyUpdateHunks(original, [
      {
        lines: [
          { kind: "-", text: "bar" },
          { kind: "+", text: "qux" },
        ],
      },
    ]);
    expect(updated).toBe(`foo
qux
baz
`);

    const padded = applyUpdateHunks(`  foo  \nbar\n`, [
      {
        lines: [
          { kind: "-", text: "foo" },
          { kind: "+", text: "FOO" },
        ],
      },
    ]);
    expect(padded).toBe(`FOO
bar
`);
  });

  test("NormalizeToLf: non-empty update result ends with newline", () => {
    const updated = applyUpdateHunks("a\nb", [
      {
        lines: [
          { kind: "-", text: "b" },
          { kind: "+", text: "c" },
        ],
      },
    ]);
    expect(updated).toBe("a\nc\n");
    expect(updated.endsWith("\n")).toBe(true);
  });

  test("throws when context cannot be found", () => {
    expect(() =>
      applyUpdateHunks("a\nb\n", [
        {
          lines: [
            { kind: "-", text: "missing" },
            { kind: "+", text: "x" },
          ],
        },
      ]),
    ).toThrow(/failed to find expected lines/);
  });
});
