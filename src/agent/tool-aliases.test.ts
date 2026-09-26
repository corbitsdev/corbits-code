import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@intx/types/runtime";
import { createDynamicToolRunner } from "../tui/dynamic-tool-runner.js";
import {
  advertisedTools,
  CORE_TOOL_NAMES,
  CATALOG_TOOL_NAMES,
} from "./tool-search.js";
import { canonicalToolName } from "./canonical-tool-name.js";
import { advertisedToolName, WIRE_TO_ENGINE } from "./tool-aliases.js";
import { evaluateApprovals } from "../permission/authz-grants.js";

const noWorkspace = { resolvedCwd: "/repo", roots: ["/repo"] };

const posixDef = (name: string): ToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {}, required: [] },
});

describe("one advertised posix set", () => {
  test("CORE+CATALOG is the 1:1 wire set without engine or Codex names", () => {
    const advertised = [...CORE_TOOL_NAMES, ...CATALOG_TOOL_NAMES];
    expect(CORE_TOOL_NAMES.slice(0, 6)).toEqual([
      "read",
      "write",
      "edit",
      "delete",
      "lsp",
      "bash",
    ]);
    expect(CATALOG_TOOL_NAMES[0]).toBe("glob");
    expect(advertised).toContain("grep");
    expect(advertised).not.toContain("read_file");
    expect(advertised).not.toContain("write_file");
    expect(advertised).not.toContain("edit_file");
    expect(advertised).not.toContain("delete_file");
    expect(advertised).not.toContain("run_shell");
    expect(advertised).not.toContain("search_files");
    expect(advertised).not.toContain("list_dir");
    expect(advertised).not.toContain("apply_patch");
    expect(advertised).not.toContain("shell");
    expect(advertised).not.toContain("update_plan");
    expect(new Set(advertised).size).toBe(advertised.length);
  });

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

  test("delete is advertised; list_dir is not", () => {
    expect(CORE_TOOL_NAMES).toContain("delete");
    expect(CATALOG_TOOL_NAMES).not.toContain("list_dir");
    expect(CORE_TOOL_NAMES).not.toContain("list_dir");
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

  test("a stored update_plan grant still covers update_plan (create-equivalent) use", async () => {
    expect(
      await evaluateApprovals({
        tool: "update_plan",
        subject: "update_plan",
        approvals: [{ tool: "update_plan", pattern: "*" }],
        workspace: noWorkspace,
      }),
    ).toBe(true);
  });

  test("a stored manage_tasks grant covers update_plan (engine covers alias)", async () => {
    expect(
      await evaluateApprovals({
        tool: "update_plan",
        subject: "update_plan",
        approvals: [{ tool: "manage_tasks", pattern: "*" }],
        workspace: noWorkspace,
      }),
    ).toBe(true);
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
