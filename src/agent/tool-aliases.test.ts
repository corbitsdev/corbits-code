import { describe, expect, test } from "bun:test";
import type { ToolCall, ToolDefinition } from "@intx/types/runtime";
import { createDynamicToolRunner } from "../tui/dynamic-tool-runner.js";
import { advertisedTools } from "./tool-search.js";
import { canonicalToolName } from "./canonical-tool-name.js";
import {
  advertisedToolName,
  authzParityDefinitions,
  withAuthzParityDefinitions,
  WIRE_TO_ENGINE,
} from "./tool-aliases.js";
import { evaluateApprovals } from "../permission/authz-grants.js";

const noWorkspace = { resolvedCwd: "/repo", roots: ["/repo"] };

const posixDef = (name: string): ToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {}, required: [] },
});

describe("one advertised posix set", () => {
  test("advertisedTools projects engine defs onto one wire name each", () => {
    const registry = [
      posixDef("read_file"),
      posixDef("write_file"),
      posixDef("edit_file"),
      posixDef("delete_file"),
      posixDef("run_shell"),
      posixDef("search_files"),
      posixDef("grep"),
      posixDef("list_dir"),
      posixDef("lsp"),
    ];
    const names = advertisedTools(registry).map((d) => d.name);
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("edit");
    expect(names).toContain("delete");
    expect(names).toContain("bash");
    expect(names).toContain("glob");
    expect(names).toContain("grep");
    expect(names).not.toContain("read_file");
    expect(names).not.toContain("run_shell");
    expect(names).not.toContain("search_files");
    expect(names).not.toContain("list_dir");
    expect(names).not.toContain("delete_file");
  });
});

describe("grant aliases", () => {
  test("a grant stored as run_shell covers bash", async () => {
    expect(
      await evaluateApprovals({
        tool: "bash",
        subject: "npm test",
        approvals: [{ tool: "run_shell", pattern: "npm *" }],
        workspace: noWorkspace,
      }),
    ).toBe(true);
  });

  test("a grant stored as bash matches a run_shell request after canonicalize", async () => {
    expect(
      await evaluateApprovals({
        tool: "run_shell",
        subject: "npm test",
        approvals: [{ tool: "bash", pattern: "npm *" }],
        workspace: noWorkspace,
      }),
    ).toBe(true);
  });

  test("pure renames stay bidirectional: read covers read_file and vice versa", async () => {
    expect(
      await evaluateApprovals({
        tool: "read_file",
        subject: "src/a.ts",
        approvals: [{ tool: "read", pattern: "src/*" }],
        workspace: noWorkspace,
      }),
    ).toBe(true);
    expect(
      await evaluateApprovals({
        tool: "read",
        subject: "src/a.ts",
        approvals: [{ tool: "read_file", pattern: "src/*" }],
        workspace: noWorkspace,
      }),
    ).toBe(true);
  });

  // update_plan hidden-dispatches onto manage_tasks but is NOT
  // capability-identical: it only ever translates to action:"create" with
  // todo/doing/done statuses, while manage_tasks spans the full lifecycle
  // (create/update, including cancelled). Grant coverage is one-directional:
  // a stored update_plan grant must never cover a manage_tasks request.
  // Live requests never present as aliases (coerced before matching) and
  // seeders drop stored update_plan keys, so no same-alias replay test exists
  // here: that path is unreachable in production.
  test("a stored update_plan grant does not cover manage_tasks", async () => {
    expect(
      await evaluateApprovals({
        tool: "manage_tasks",
        subject: "manage_tasks",
        approvals: [{ tool: "update_plan", pattern: "*" }],
        workspace: noWorkspace,
      }),
    ).toBe(false);
  });

  test("a stored manage_tasks grant covers manage_tasks", async () => {
    expect(
      await evaluateApprovals({
        tool: "manage_tasks",
        subject: "manage_tasks",
        approvals: [{ tool: "manage_tasks", pattern: "*" }],
        workspace: noWorkspace,
      }),
    ).toBe(true);
  });

  test("canonicalToolName maps wire and hidden aliases onto engines", () => {
    expect(canonicalToolName("bash")).toBe("run_shell");
    expect(canonicalToolName("shell")).toBe("run_shell");
    expect(canonicalToolName("read")).toBe("read_file");
    expect(canonicalToolName("update_plan")).toBe("manage_tasks");
    expect(canonicalToolName("default.bash")).toBe("run_shell");
    expect(canonicalToolName("apply_patch")).toBe("apply_patch");
  });
});

describe("hidden alias dispatch", () => {
  test("bash and run_shell both reach the engine without dual-registering", async () => {
    let seen = "";
    const runner = createDynamicToolRunner([
      {
        kind: "string",
        definition: posixDef("run_shell"),
        handler: async (args) => {
          seen = String(args.command ?? "");
          return "ok";
        },
      },
    ]);
    runner.setCallGate((name) => name === "run_shell" || name === "bash");
    const viaBash = await runner.run(
      { id: "1", name: "bash", arguments: { command: "echo hi" } },
      new AbortController().signal,
    );
    expect(viaBash.content).toBe("ok");
    expect(seen).toBe("echo hi");
    const viaEngine = await runner.run(
      { id: "2", name: "run_shell", arguments: { command: "echo ho" } },
      new AbortController().signal,
    );
    expect(viaEngine.content).toBe("ok");
    expect(seen).toBe("echo ho");
  });

  test("shell coerces argv/workdir/timeout_ms onto run_shell", async () => {
    let seen: Record<string, unknown> = {};
    const runner = createDynamicToolRunner([
      {
        kind: "string",
        definition: posixDef("run_shell"),
        handler: async (args) => {
          seen = args;
          return "ok";
        },
      },
    ]);
    runner.setCallGate(() => true);
    const result = await runner.run(
      {
        id: "1",
        name: "shell",
        arguments: {
          command: ["bash", "-lc", "ls"],
          workdir: "/tmp",
          timeout_ms: 5000,
        },
      },
      new AbortController().signal,
    );
    expect(result.content).toBe("ok");
    expect(seen.command).toBe("ls");
    expect(seen.cwd).toBe("/tmp");
    expect(seen.timeout).toBe(5000);
  });

  test("update_plan hidden-dispatches onto manage_tasks; apply_patch does not", async () => {
    const runner = createDynamicToolRunner([
      {
        kind: "string",
        definition: posixDef("manage_tasks"),
        handler: async (args) => JSON.stringify(args),
      },
    ]);
    runner.setCallGate(() => true);
    const plan = await runner.run(
      {
        id: "1",
        name: "update_plan",
        arguments: {
          plan: [{ step: "Do the thing", status: "in_progress" }],
        },
      },
      new AbortController().signal,
    );
    expect(plan.isError).toBeFalsy();
    expect(plan.content).toContain('"action":"create"');
    const patch = await runner.run(
      { id: "2", name: "apply_patch", arguments: { input: "x" } },
      new AbortController().signal,
    );
    expect(patch.isError).toBe(true);
    expect(patch.content).toContain("unknown tool");
  });

  test("WIRE_TO_ENGINE is 1:1", () => {
    const engines = Object.values(WIRE_TO_ENGINE);
    expect(new Set(engines).size).toBe(engines.length);
    expect(advertisedToolName("run_shell")).toBe("bash");
  });

  test("Codex does not advertise shell+run_shell or apply_patch", () => {
    const names = advertisedTools([
      posixDef("read_file"),
      posixDef("write_file"),
      posixDef("edit_file"),
      posixDef("delete_file"),
      posixDef("run_shell"),
      posixDef("search_files"),
      posixDef("grep"),
      posixDef("manage_tasks"),
      posixDef("list_dir"),
    ]).map((d) => d.name);
    expect(
      names.filter((n) => n === "bash" || n === "run_shell" || n === "shell"),
    ).toEqual(["bash"]);
    expect(names).not.toContain("apply_patch");
    expect(names).not.toContain("update_plan");
    expect(names).not.toContain("list_dir");
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("authz parity definitions", () => {
  test("run_shell gains bash and shell copies that rename name only", () => {
    const native = posixDef("run_shell");
    const defs = authzParityDefinitions([native]);
    expect(defs.map((d) => d.name)).toEqual(["run_shell", "bash", "shell"]);
    const byName = new Map(defs.map((d) => [d.name, d]));
    expect(byName.get("run_shell")).toBe(native);
    expect(byName.get("bash")).toEqual({ ...native, name: "bash" });
    expect(byName.get("shell")).toEqual({ ...native, name: "shell" });
  });

  test("read_file gains a read copy; MCP defs pass through untouched", () => {
    const mcp = posixDef("mcp__linear__save_issue");
    const defs = authzParityDefinitions([posixDef("read_file"), mcp]);
    expect(defs.map((d) => d.name)).toEqual([
      "read_file",
      "mcp__linear__save_issue",
      "read",
    ]);
    expect(defs.find((d) => d.name === "mcp__linear__save_issue")).toBe(mcp);
  });

  test("manage_tasks never gains an update_plan snapshot copy", () => {
    const defs = authzParityDefinitions([
      posixDef("manage_tasks"),
      posixDef("run_shell"),
    ]);
    const names = defs.map((d) => d.name);
    expect(names).toContain("manage_tasks");
    expect(names).not.toContain("update_plan");
    expect(names).toContain("bash");
    expect(names).toContain("shell");
  });

  test("already-aliased and duplicate defs dedup by name", () => {
    const defs = authzParityDefinitions([
      posixDef("run_shell"),
      posixDef("bash"),
      posixDef("run_shell"),
    ]);
    expect(defs.map((d) => d.name)).toEqual(["run_shell", "bash", "shell"]);
  });

  test("empty registry stays empty", () => {
    expect(authzParityDefinitions([])).toEqual([]);
  });
});

describe("withAuthzParityDefinitions", () => {
  test("definitions getter returns parity over the live set; run delegates", async () => {
    let live: ToolDefinition[] = [posixDef("run_shell")];
    let ran: ToolCall | undefined;
    const bundle = {
      definitions: live,
      currentDefinitions: () => live,
      run: async (call: ToolCall, _signal: AbortSignal) => {
        ran = call;
        return { callId: call.id, content: "ok", isError: false };
      },
      addTools: () => undefined,
      setCallGate: () => undefined,
    };
    const wrapped = withAuthzParityDefinitions(bundle);
    expect(wrapped.definitions.map((d) => d.name)).toEqual([
      "run_shell",
      "bash",
      "shell",
    ]);
    live = [...live, posixDef("mcp__acme__do")];
    expect(wrapped.definitions.map((d) => d.name)).toEqual([
      "run_shell",
      "mcp__acme__do",
      "bash",
      "shell",
    ]);
    const call = {
      id: "1",
      name: "bash",
      arguments: { command: "echo hi" },
    };
    await wrapped.run(call, new AbortController().signal);
    expect(ran).toBe(call);
  });

  test("falls back to definitions when currentDefinitions is absent", () => {
    const bundle = {
      definitions: [posixDef("read_file")] as readonly ToolDefinition[],
      run: async () => ({ callId: "1", content: "", isError: false }),
    };
    expect(
      withAuthzParityDefinitions(bundle).definitions.map((d) => d.name),
    ).toEqual(["read_file", "read"]);
  });
});
