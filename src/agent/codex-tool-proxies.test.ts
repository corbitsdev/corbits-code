import { describe, expect, test } from "bun:test";
import { createToolRunner } from "@intx/agent";
import type { AgentTool } from "@intx/agent";

import {
  allowDeleteFromCapabilities,
  allowShellFromCapabilities,
  createCodexToolProxies,
  type CodexReadRawFile,
  type CodexRunManageTasks,
  type CodexRunTool,
} from "./codex-tool-proxies.js";
import { DOCS_TOOLS, BUILD_TOOLS } from "./directors/tool-sets.js";
import { applyManageTasks, parseManageTasksArgs, type Task } from "./tasks.js";

interface Call {
  name: string;
  args: Record<string, unknown>;
}

// `manage_tasks` is deliberately NOT a branch here: the real posixTools
// registry runTool forwards to has no manage_tasks handler (only
// read_file/write_file/run_shell/edit_file/search_files/grep + the
// delete_file plugin), so an unrecognized name falling through to the
// `unknown tool` branch is the accurate stand-in for that registry.
function makeRecorder(initial: Record<string, string> = {}): {
  calls: Call[];
  files: Map<string, string>;
  runTool: CodexRunTool;
  readRawFile: CodexReadRawFile;
} {
  const files = new Map(Object.entries(initial));
  const calls: Call[] = [];
  const readRawFile: CodexReadRawFile = async (path) => {
    const content = files.get(path);
    if (content === undefined) {
      return { content: `File not found: ${path}`, isError: true };
    }
    return { content };
  };
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
    if (name === "run_shell") {
      return { content: `ran: ${JSON.stringify(args)}` };
    }
    return { content: `unknown tool: ${name}`, isError: true };
  };
  return { calls, files, runTool, readRawFile };
}

const unusedManageTasks: CodexRunManageTasks = async () => ({ content: "unused" });
const unusedReadRawFile: CodexReadRawFile = async () => ({ content: "unused" });

// A real manage_tasks dispatch: parses with the actual arktype schema and
// mutates a real Task[] with the actual applyManageTasks reducer from
// tasks.ts — the same two functions the manage_tasks stringTool handlers in
// src/agent/tools.ts and src/subagent/run.ts call. No mock recorder involved.
function makeRealManageTasks(): {
  calls: Record<string, unknown>[];
  getTasks: () => Task[];
  runManageTasks: CodexRunManageTasks;
} {
  let tasks: Task[] = [];
  const calls: Record<string, unknown>[] = [];
  const runManageTasks: CodexRunManageTasks = async (rawArgs) => {
    calls.push(rawArgs);
    const parsed = parseManageTasksArgs(rawArgs);
    if (parsed === null) {
      return {
        content: "Error: manage_tasks requires action ('create' or 'update').",
        isError: true,
      };
    }
    tasks = applyManageTasks(tasks, parsed);
    return { content: "Tasks updated." };
  };
  return { calls, getTasks: () => tasks, runManageTasks };
}

async function invokeApplyPatch(tools: AgentTool[], input: string) {
  const runner = createToolRunner(tools);
  return runner.run(
    { id: "call-1", name: "apply_patch", arguments: { input } },
    new AbortController().signal,
  );
}

async function invokeTool(tools: AgentTool[], name: string, args: Record<string, unknown>) {
  const runner = createToolRunner(tools);
  return runner.run({ id: "call-1", name, arguments: args }, new AbortController().signal);
}

describe("createCodexToolProxies", () => {
  test("returns [] when not Codex", () => {
    const tools = createCodexToolProxies({
      isCodex: false,
      runTool: async () => ({ content: "unused" }),
      readRawFile: unusedReadRawFile,
      runManageTasks: unusedManageTasks,
    });
    expect(tools).toEqual([]);
  });

  test("returns apply_patch, shell, update_plan stringTools when Codex", () => {
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool: async () => ({ content: "unused" }),
      readRawFile: unusedReadRawFile,
      runManageTasks: unusedManageTasks,
    });
    expect(tools.map((t) => t.definition.name)).toEqual(["apply_patch", "shell", "update_plan"]);
    expect(tools.every((t) => t.kind === "string")).toBe(true);
    expect(tools[0]!.definition.inputSchema).toMatchObject({
      required: ["input"],
    });
  });

  test("add forwards write_file with Codex trailing newline", async () => {
    const { calls, files, runTool, readRawFile } = makeRecorder();
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool,
      readRawFile,
      runManageTasks: unusedManageTasks,
    });
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
    const { calls, files, runTool, readRawFile } = makeRecorder({ "obsolete.txt": "gone" });
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool,
      readRawFile,
      runManageTasks: unusedManageTasks,
    });
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
    const { calls, files, runTool, readRawFile } = makeRecorder({ "obsolete.txt": "gone" });
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool,
      readRawFile,
      allowDelete: false,
      runManageTasks: unusedManageTasks,
    });
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
    const { calls, files, runTool, readRawFile } = makeRecorder({ "src/app.py": original });
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool,
      readRawFile,
      allowDelete: false,
      runManageTasks: unusedManageTasks,
    });
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
    const { calls, files, runTool, readRawFile } = makeRecorder({ "src/app.py": original });
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool,
      readRawFile,
      allowDelete: false,
      runManageTasks: unusedManageTasks,
    });
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
    expect(calls.map((c) => c.name)).toEqual(["write_file"]);
    expect(files.get("src/app.py")).toBe(`def greet():
print("Hello, world!")
`);
  });

  test("update reads, applies hunks, and writes", async () => {
    const original = `def greet():
print("Hi")
print("bye")
`;
    const { calls, files, runTool, readRawFile } = makeRecorder({ "src/app.py": original });
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool,
      readRawFile,
      runManageTasks: unusedManageTasks,
    });
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
    expect(calls.map((c) => c.name)).toEqual(["write_file"]);
    expect(calls[0]!.args.path).toBe("src/app.py");
    expect(files.get("src/app.py")).toBe(`def greet():
print("Hello, world!")
print("bye")
`);
  });

  test("update with Move to writes new path then deletes old", async () => {
    const original = `def greet():
print("Hi")
`;
    const { calls, files, runTool, readRawFile } = makeRecorder({ "src/app.py": original });
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool,
      readRawFile,
      runManageTasks: unusedManageTasks,
    });
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
    expect(calls.map((c) => c.name)).toEqual(["write_file", "delete_file"]);
    expect(calls[0]!.args.path).toBe("src/main.py");
    expect(calls[0]!.args.content).toBe(`def greet():
print("Hello, world!")
`);
    expect(calls[1]!.args).toEqual({ path: "src/app.py" });
    expect(files.has("src/app.py")).toBe(false);
    expect(files.get("src/main.py")).toBe(`def greet():
print("Hello, world!")
`);
  });

  test("multi-op patch runs each op in order", async () => {
    const { calls, files, runTool, readRawFile } = makeRecorder({
      "src/app.py": "old\n",
      "obsolete.txt": "x",
    });
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool,
      readRawFile,
      runManageTasks: unusedManageTasks,
    });
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
    expect(calls.map((c) => c.name)).toEqual(["write_file", "write_file", "delete_file"]);
    expect(files.get("hello.txt")).toBe("Hello world\n");
    expect(files.get("src/app.py")).toBe("new\n");
    expect(files.has("obsolete.txt")).toBe(false);
  });

  test("parse failure surfaces as tool error (isError)", async () => {
    const { calls, runTool, readRawFile } = makeRecorder();
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool,
      readRawFile,
      runManageTasks: unusedManageTasks,
    });
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
      readRawFile: unusedReadRawFile,
      runManageTasks: unusedManageTasks,
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
    const { runTool, readRawFile } = makeRecorder();
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool,
      readRawFile,
      runManageTasks: unusedManageTasks,
    });
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

describe("shell proxy", () => {
  test("string command forwards to run_shell", async () => {
    const { calls, runTool, readRawFile } = makeRecorder();
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool,
      readRawFile,
      runManageTasks: unusedManageTasks,
    });
    const result = await invokeTool(tools, "shell", { command: "ls -la" });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([{ name: "run_shell", args: { command: "ls -la" } }]);
  });

  test("bash -lc argv triple unwraps to the script", async () => {
    const { calls, runTool, readRawFile } = makeRecorder();
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool,
      readRawFile,
      runManageTasks: unusedManageTasks,
    });
    await invokeTool(tools, "shell", { command: ["bash", "-lc", "echo 'hi there'"] });
    expect(calls).toEqual([{ name: "run_shell", args: { command: "echo 'hi there'" } }]);
  });

  test("other argv arrays are shell-quoted and joined", async () => {
    const { calls, runTool, readRawFile } = makeRecorder();
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool,
      readRawFile,
      runManageTasks: unusedManageTasks,
    });
    await invokeTool(tools, "shell", { command: ["echo", "hello world"] });
    expect(calls).toEqual([{ name: "run_shell", args: { command: "echo 'hello world'" } }]);
  });

  test("workdir and timeout_ms translate to cwd and timeout", async () => {
    const { calls, runTool, readRawFile } = makeRecorder();
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool,
      readRawFile,
      runManageTasks: unusedManageTasks,
    });
    await invokeTool(tools, "shell", {
      command: "pwd",
      workdir: "/tmp/work",
      timeout_ms: 5000,
    });
    expect(calls).toEqual([
      { name: "run_shell", args: { command: "pwd", cwd: "/tmp/work", timeout: 5000 } },
    ]);
  });

  test("missing command surfaces as tool error", async () => {
    const { calls, runTool, readRawFile } = makeRecorder();
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool,
      readRawFile,
      runManageTasks: unusedManageTasks,
    });
    const result = await invokeTool(tools, "shell", {});
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/command/);
    expect(calls).toEqual([]);
  });

  test("allowShell false refuses without calling run_shell", async () => {
    const { calls, runTool, readRawFile } = makeRecorder();
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool,
      readRawFile,
      allowShell: false,
      runManageTasks: unusedManageTasks,
    });
    const result = await invokeTool(tools, "shell", { command: "ls" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not allowed/);
    expect(calls).toEqual([]);
  });

  test("run_shell isError propagates as tool error", async () => {
    const runTool: CodexRunTool = async () => ({ content: "boom", isError: true });
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool,
      readRawFile: unusedReadRawFile,
      runManageTasks: unusedManageTasks,
    });
    const result = await invokeTool(tools, "shell", { command: "ls" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/boom/);
  });
});

describe("update_plan proxy", () => {
  // Real dispatch, not a mock recorder: runManageTasks here is
  // makeRealManageTasks, which parses with the real parseManageTasksArgs and
  // mutates a real Task[] with the real applyManageTasks reducer from
  // tasks.ts — the same two functions the manage_tasks stringTool handlers
  // wire up in src/agent/tools.ts and src/subagent/run.ts. This is what would
  // have caught the dead-dispatch bug: routing update_plan through `runTool`
  // (which only reaches posixTools, with no manage_tasks handler) fails with
  // "unknown tool: manage_tasks" the instant this real dispatch is invoked,
  // even though the old mock recorder's `if (name === "manage_tasks")`
  // special case made every existing test pass.
  test("maps plan steps onto manage_tasks(action=create) and actually mutates the task list", async () => {
    const { calls, getTasks, runManageTasks } = makeRealManageTasks();
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool: async () => ({ content: "unused" }),
      readRawFile: unusedReadRawFile,
      runManageTasks,
    });
    const result = await invokeTool(tools, "update_plan", {
      explanation: "getting started",
      plan: [
        { step: "Read the file", status: "completed" },
        { step: "Write the fix", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([
      {
        action: "create",
        tasks: [
          { id: "p1", title: "Read the file", status: "done" },
          { id: "p2", title: "Write the fix", status: "doing" },
          { id: "p3", title: "Run tests", status: "todo" },
        ],
      },
    ]);
    // The real Task[] state, produced by the real applyManageTasks reducer —
    // proof the dispatch reaches an actual task store, not just a recorded call.
    expect(getTasks()).toEqual([
      { id: "p1", title: "Read the file", status: "done" },
      { id: "p2", title: "Write the fix", status: "doing" },
      { id: "p3", title: "Run tests", status: "todo" },
    ]);
  });

  test("malformed plan surfaces as tool error", async () => {
    const { calls, runManageTasks } = makeRealManageTasks();
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool: async () => ({ content: "unused" }),
      readRawFile: unusedReadRawFile,
      runManageTasks,
    });
    const result = await invokeTool(tools, "update_plan", {
      plan: [{ step: "no status here" }],
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/plan/);
    expect(calls).toEqual([]);
  });

  test("missing plan surfaces as tool error", async () => {
    const { calls, runManageTasks } = makeRealManageTasks();
    const tools = createCodexToolProxies({
      isCodex: true,
      runTool: async () => ({ content: "unused" }),
      readRawFile: unusedReadRawFile,
      runManageTasks,
    });
    const result = await invokeTool(tools, "update_plan", {});
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("allowDeleteFromCapabilities", () => {
  test("docs allowlist (includes delete_file) → true; build → true", () => {
    expect(allowDeleteFromCapabilities({ mode: "allow", tools: DOCS_TOOLS })).toBe(true);
    expect(allowDeleteFromCapabilities({ mode: "allow", tools: BUILD_TOOLS })).toBe(true);
    expect(allowDeleteFromCapabilities(undefined)).toBe(true);
    expect(allowDeleteFromCapabilities({ mode: "exclude", tools: ["run_shell"] })).toBe(true);
    expect(allowDeleteFromCapabilities({ mode: "exclude", tools: ["delete_file"] })).toBe(false);
  });
});

describe("allowShellFromCapabilities", () => {
  test("docs allowlist (no run_shell) → false; build → true", () => {
    expect(allowShellFromCapabilities({ mode: "allow", tools: DOCS_TOOLS })).toBe(false);
    expect(allowShellFromCapabilities({ mode: "allow", tools: BUILD_TOOLS })).toBe(true);
    expect(allowShellFromCapabilities(undefined)).toBe(true);
    expect(allowShellFromCapabilities({ mode: "exclude", tools: ["delete_file"] })).toBe(true);
    expect(allowShellFromCapabilities({ mode: "exclude", tools: ["run_shell"] })).toBe(false);
  });
});
