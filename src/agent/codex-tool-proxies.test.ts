import { describe, expect, test } from "bun:test";
import { createToolRunner } from "@intx/agent";
import type { AgentTool } from "@intx/agent";

import {
  allowDeleteFromCapabilities,
  createCodexToolProxies,
  type CodexRunTool,
} from "./codex-tool-proxies.js";
import { DOCS_TOOLS, IMPLEMENT_TOOLS } from "./directors/tool-sets.js";

type Call = { name: string; args: Record<string, unknown> };

function makeRecorder(initial: Record<string, string> = {}): {
  calls: Call[];
  files: Map<string, string>;
  runTool: CodexRunTool;
} {
  const files = new Map(Object.entries(initial));
  const calls: Call[] = [];
  const runTool: CodexRunTool = async (name, args) => {
    calls.push({ name, args });
    if (name === "read_file") {
      const path = String(args.path ?? "");
      const content = files.get(path);
      if (content === undefined) {
        return { content: `File not found: ${path}`, isError: true };
      }
      return { content };
    }
    if (name === "write_file") {
      const path = String(args.path ?? "");
      files.set(path, String(args.content ?? ""));
      return { content: `Wrote file: ${path}` };
    }
    if (name === "delete_file") {
      const path = String(args.path ?? "");
      files.delete(path);
      return { content: `Deleted file: ${path}` };
    }
    return { content: `unknown tool: ${name}`, isError: true };
  };
  return { calls, files, runTool };
}

async function invokeApplyPatch(tools: AgentTool[], input: string) {
  const runner = createToolRunner(tools);
  return runner.run(
    { id: "call-1", name: "apply_patch", arguments: { input } },
    new AbortController().signal,
  );
}

describe("createCodexToolProxies", () => {
  test("returns [] when not Codex", () => {
    const tools = createCodexToolProxies({
      isCodex: false,
      runTool: async () => ({ content: "unused" }),
    });
    expect(tools).toEqual([]);
  });

  test("returns apply_patch stringTool when Codex", () => {
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool: async () => ({ content: "unused" }),
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]!.definition.name).toBe("apply_patch");
    expect(tools[0]!.kind).toBe("string");
    expect(tools[0]!.definition.inputSchema).toMatchObject({
      required: ["input"],
    });
  });

  test("add forwards write_file with Codex trailing newline", async () => {
    const { calls, files, runTool } = makeRecorder();
    const tools = createCodexToolProxies({ isCodex: true, runTool });
    const result = await invokeApplyPatch(
      tools,
      `*** Begin Patch
*** Add File: hello.txt
+Hello world
+second line
*** End Patch
`,
    );
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([
      {
        name: "write_file",
        args: { path: "hello.txt", content: "Hello world\nsecond line\n" },
      },
    ]);
    expect(files.get("hello.txt")).toBe("Hello world\nsecond line\n");
    expect(result.content).toContain("Wrote file: hello.txt");
  });

  test("delete forwards delete_file", async () => {
    const { calls, files, runTool } = makeRecorder({ "obsolete.txt": "gone" });
    const tools = createCodexToolProxies({ isCodex: true, runTool });
    const result = await invokeApplyPatch(
      tools,
      `*** Begin Patch
*** Delete File: obsolete.txt
*** End Patch
`,
    );
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([{ name: "delete_file", args: { path: "obsolete.txt" } }]);
    expect(files.has("obsolete.txt")).toBe(false);
    expect(result.content).toContain("Deleted file: obsolete.txt");
  });

  test("allowDelete false refuses Delete without calling delete_file", async () => {
    const { calls, files, runTool } = makeRecorder({ "obsolete.txt": "gone" });
    const tools = createCodexToolProxies({ isCodex: true, runTool, allowDelete: false });
    const result = await invokeApplyPatch(
      tools,
      `*** Begin Patch
*** Delete File: obsolete.txt
*** End Patch
`,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Delete File is not allowed/);
    expect(result.content).toMatch(/delete_file capability missing/);
    expect(calls).toEqual([]);
    expect(files.get("obsolete.txt")).toBe("gone");
  });

  test("allowDelete false refuses Update+Move without calling delete_file", async () => {
    const original = `def greet():
print("Hi")
`;
    const { calls, files, runTool } = makeRecorder({ "src/app.py": original });
    const tools = createCodexToolProxies({ isCodex: true, runTool, allowDelete: false });
    const result = await invokeApplyPatch(
      tools,
      `*** Begin Patch
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** End Patch
`,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Move to is not allowed/);
    expect(calls).toEqual([]);
    expect(files.get("src/app.py")).toBe(original);
    expect(files.has("src/main.py")).toBe(false);
  });

  test("allowDelete false still allows Update without move", async () => {
    const original = `def greet():
print("Hi")
`;
    const { calls, files, runTool } = makeRecorder({ "src/app.py": original });
    const tools = createCodexToolProxies({ isCodex: true, runTool, allowDelete: false });
    const result = await invokeApplyPatch(
      tools,
      `*** Begin Patch
*** Update File: src/app.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** End Patch
`,
    );
    expect(result.isError).toBeFalsy();
    expect(calls.map((c) => c.name)).toEqual(["read_file", "write_file"]);
    expect(files.get("src/app.py")).toBe(`def greet():
print("Hello, world!")
`);
  });

  test("update reads, applies hunks, and writes", async () => {
    const original = `def greet():
print("Hi")
print("bye")
`;
    const { calls, files, runTool } = makeRecorder({ "src/app.py": original });
    const tools = createCodexToolProxies({ isCodex: true, runTool });
    const result = await invokeApplyPatch(
      tools,
      `*** Begin Patch
*** Update File: src/app.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** End Patch
`,
    );
    expect(result.isError).toBeFalsy();
    expect(calls.map((c) => c.name)).toEqual(["read_file", "write_file"]);
    expect(calls[0]!.args).toEqual({ path: "src/app.py" });
    expect(calls[1]!.args.path).toBe("src/app.py");
    expect(files.get("src/app.py")).toBe(`def greet():
print("Hello, world!")
print("bye")
`);
  });

  test("update with Move to writes new path then deletes old", async () => {
    const original = `def greet():
print("Hi")
`;
    const { calls, files, runTool } = makeRecorder({ "src/app.py": original });
    const tools = createCodexToolProxies({ isCodex: true, runTool });
    const result = await invokeApplyPatch(
      tools,
      `*** Begin Patch
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** End Patch
`,
    );
    expect(result.isError).toBeFalsy();
    expect(calls.map((c) => c.name)).toEqual(["read_file", "write_file", "delete_file"]);
    expect(calls[0]!.args).toEqual({ path: "src/app.py" });
    expect(calls[1]!.args.path).toBe("src/main.py");
    expect(calls[1]!.args.content).toBe(`def greet():
print("Hello, world!")
`);
    expect(calls[2]!.args).toEqual({ path: "src/app.py" });
    expect(files.has("src/app.py")).toBe(false);
    expect(files.get("src/main.py")).toBe(`def greet():
print("Hello, world!")
`);
  });

  test("multi-op patch runs each op in order", async () => {
    const { calls, files, runTool } = makeRecorder({
      "src/app.py": "old\n",
      "obsolete.txt": "x",
    });
    const tools = createCodexToolProxies({ isCodex: true, runTool });
    const result = await invokeApplyPatch(
      tools,
      `*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
@@
-old
+new
*** Delete File: obsolete.txt
*** End Patch
`,
    );
    expect(result.isError).toBeFalsy();
    expect(calls.map((c) => c.name)).toEqual([
      "write_file",
      "read_file",
      "write_file",
      "delete_file",
    ]);
    expect(files.get("hello.txt")).toBe("Hello world\n");
    expect(files.get("src/app.py")).toBe("new\n");
    expect(files.has("obsolete.txt")).toBe(false);
  });

  test("parse failure surfaces as tool error (isError)", async () => {
    const { calls, runTool } = makeRecorder();
    const tools = createCodexToolProxies({ isCodex: true, runTool });
    const result = await invokeApplyPatch(
      tools,
      `*** Add File: a.txt
+hi
*** End Patch
`,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Begin Patch/);
    expect(calls).toEqual([]);
  });

  test("missing input surfaces as tool error", async () => {
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool: async () => ({ content: "unused" }),
    });
    const runner = createToolRunner(tools);
    const result = await runner.run(
      { id: "call-1", name: "apply_patch", arguments: {} },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/input/);
  });

  test("runTool isError aborts the patch with isError", async () => {
    const { runTool } = makeRecorder();
    const tools = createCodexToolProxies({ isCodex: true, runTool });
    const result = await invokeApplyPatch(
      tools,
      `*** Begin Patch
*** Update File: missing.py
@@
-a
+b
*** End Patch
`,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/missing\.py/);
  });
});

describe("allowDeleteFromCapabilities", () => {
  test("docs allowlist (no delete_file) → false; implement → true", () => {
    expect(
      allowDeleteFromCapabilities({ mode: "allow", tools: DOCS_TOOLS }),
    ).toBe(false);
    expect(
      allowDeleteFromCapabilities({ mode: "allow", tools: IMPLEMENT_TOOLS }),
    ).toBe(true);
    expect(allowDeleteFromCapabilities(undefined)).toBe(true);
    expect(
      allowDeleteFromCapabilities({ mode: "exclude", tools: ["run_shell"] }),
    ).toBe(true);
    expect(
      allowDeleteFromCapabilities({ mode: "exclude", tools: ["delete_file"] }),
    ).toBe(false);
  });
});
