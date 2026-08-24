/**
 * CL-5170: permission.wait and subagent spans at the ask gate and task fleet.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";
import { createPermissionGate } from "../permission/gate.js";
import { createTaskTool } from "../subagent/task-tool.js";
import { clear, snapshot, type PerfSpan } from "./index.js";
import { createPerfReactorObserver, currentTurnId } from "./reactor-spans.js";

// The span store is process-wide, so a perf test cannot assume the tests that
// ran before it in this process left it empty. Reset on both edges.
beforeEach(() => {
  clear();
});

afterEach(() => {
  clear();
});

function byName(spans: PerfSpan[], name: string): PerfSpan[] {
  return spans.filter((s) => s.name === name);
}

function completed(spans: PerfSpan[]): PerfSpan[] {
  return spans.filter((s) => s.endNs !== undefined);
}

function event(type: string, data: unknown = {}): ReactorEmittedEvent {
  return { type, seq: 1, data } as ReactorEmittedEvent;
}

const shellCall = (command: string) =>
  ({ id: "c1", name: "run_shell", arguments: { command } }) as const;

const provider = {
  providerName: "test-provider",
  baseURL: "http://localhost",
  model: "test-model",
};

const skipGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
});

describe("permission.wait spans", () => {
  test("records allow decision when operator approves a shell ask", async () => {
    const gate = createPermissionGate({
      approvals: [],
      interactive: true,
      skipPermissions: false,
      requestApproval: async () => ({ allow: true }),
    });

    const verdict = await gate.evaluate(shellCall("curl example.com"));
    expect(verdict.allowed).toBe(true);

    const waits = byName(completed(snapshot()), "permission.wait");
    expect(waits).toHaveLength(1);
    expect(waits[0]!.tags).toEqual({ tool_id: "run_shell", decision: "allow" });
  });

  test("records deny decision when operator declines", async () => {
    const gate = createPermissionGate({
      approvals: [],
      interactive: true,
      skipPermissions: false,
      requestApproval: async () => ({ allow: false, message: "nope" }),
    });

    const verdict = await gate.evaluate(shellCall("curl example.com"));
    expect(verdict.allowed).toBe(false);

    const waits = byName(completed(snapshot()), "permission.wait");
    expect(waits).toHaveLength(1);
    expect(waits[0]!.tags?.decision).toBe("deny");
    expect(waits[0]!.tags?.tool_id).toBe("run_shell");
  });

  test("permission.wait tags never include free-text reason/prompt — only tool_id + decision", async () => {
    // Gate path that would surface operator free text in the verdict reason, but
    // must never land free-text keys on the span (sanitizeTags + gate only pass
    // tool_id + allow/deny enums).
    const freeText =
      "please do not store this prompt: /Users/me/secret/key.pem and system: you are";
    const gate = createPermissionGate({
      approvals: [],
      interactive: true,
      skipPermissions: false,
      requestApproval: async () => ({ allow: false, message: freeText }),
    });

    const verdict = await gate.evaluate(shellCall("curl example.com"));
    expect(verdict.allowed).toBe(false);
    // Free text reaches the operator-facing reason only (not span tags).
    expect(!verdict.allowed && "reason" in verdict ? verdict.reason : "").toContain(freeText);

    const waits = byName(completed(snapshot()), "permission.wait");
    expect(waits).toHaveLength(1);
    const tags = waits[0]!.tags ?? {};
    // Allowlist: only tool_id + decision enums on permission.wait.
    expect(Object.keys(tags).sort()).toEqual(["decision", "tool_id"]);
    expect(tags).toEqual({ tool_id: "run_shell", decision: "deny" });
    // Explicit privacy fence: no free-text keys, and free text never appears in values.
    for (const key of [
      "reason",
      "prompt",
      "message",
      "path",
      "error",
      "action",
      "subject",
    ] as const) {
      expect(Object.hasOwn(tags, key)).toBe(false);
    }
    for (const value of Object.values(tags)) {
      expect(String(value)).not.toContain(freeText);
      expect(String(value)).not.toContain("secret");
      expect(String(value)).not.toContain("system:");
    }
  });

  test("records path-arg tool ask as permission.wait", async () => {
    const gate = createPermissionGate({
      approvals: [],
      interactive: true,
      skipPermissions: false,
      requestApproval: async () => ({ allow: true }),
    });

    const verdict = await gate.evaluate({
      id: "c2",
      name: "write_file",
      arguments: { path: "src/a.ts", content: "x" },
    });
    expect(verdict.allowed).toBe(true);

    const waits = byName(completed(snapshot()), "permission.wait");
    expect(waits).toHaveLength(1);
    expect(waits[0]!.tags).toEqual({ tool_id: "write_file", decision: "allow" });
  });

  test("closes permission.wait when requestApproval throws", async () => {
    const gate = createPermissionGate({
      approvals: [],
      interactive: true,
      skipPermissions: false,
      requestApproval: async () => {
        throw new Error("ui aborted");
      },
    });

    await expect(gate.evaluate(shellCall("curl example.com"))).rejects.toThrow("ui aborted");

    const waits = byName(completed(snapshot()), "permission.wait");
    expect(waits).toHaveLength(1);
    expect(waits[0]!.endNs).toBeDefined();
    expect(waits[0]!.tags?.tool_id).toBe("run_shell");
    // No decision tag when approval never returned.
    expect(waits[0]!.tags?.decision).toBeUndefined();
  });

  test("clear() nulls process-wide currentTurnId", () => {
    const obs = createPerfReactorObserver();
    obs.observe(event("inference.start", { model: "m" }));
    expect(currentTurnId()).not.toBeNull();
    clear();
    expect(currentTurnId()).toBeNull();
  });

  test("does not open a span when a grant auto-approves", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [{ tool: "run_shell", pattern: "npm *" }],
      interactive: true,
      skipPermissions: false,
      requestApproval: async () => {
        asked += 1;
        return { allow: true };
      },
    });

    const verdict = await gate.evaluate(shellCall("npm test"));
    expect(verdict.allowed).toBe(true);
    expect(asked).toBe(0);
    expect(byName(snapshot(), "permission.wait")).toHaveLength(0);
  });

  test("nests under the open turn when a reactor turn is active", async () => {
    const obs = createPerfReactorObserver();
    obs.observe(event("inference.start", { model: "m" }));
    obs.observe(
      event("inference.done", {
        turn: {
          role: "assistant",
          content: [{ type: "tool_call", id: "t1", name: "run_shell", arguments: {} }],
          model: "m",
          timestamp: 0,
        },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        source: { provider: "p", model: "m" },
      }),
    );
    const turnId = obs.currentTurnId();
    expect(turnId).not.toBeNull();

    const gate = createPermissionGate({
      approvals: [],
      interactive: true,
      skipPermissions: false,
      requestApproval: async () => ({ allow: true }),
    });
    await gate.evaluate(shellCall("curl x"));

    const wait = byName(completed(snapshot()), "permission.wait")[0]!;
    expect(wait.parentId).toBe(turnId!);

    obs.reset();
  });
});

describe("subagent spans", () => {
  test("records a completed subagent span around run()", async () => {
    let runEntered = false;
    const tool = createTaskTool({
      permissionGate: skipGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      run: async () => {
        runEntered = true;
        // Span must still be open while the child runs.
        const open = snapshot().filter((s) => s.name === "subagent" && s.endNs === undefined);
        expect(open).toHaveLength(1);
        expect(open[0]!.tags?.subagent_id).toBe("call-sa-1");
        return { report: "## Summary\n\nok\n" };
      },
    });
    if (tool.kind !== "full") throw new Error("expected full tool");

    const result = await tool.handler(
      {
        id: "call-sa-1",
        name: "task",
        arguments: { description: "Job", prompt: "Do it", intent: "explore" },
      },
      new AbortController().signal,
    );
    expect(runEntered).toBe(true);
    expect(typeof result.content === "string" ? result.content : "").toContain("ok");

    const agents = byName(completed(snapshot()), "subagent");
    expect(agents).toHaveLength(1);
    expect(agents[0]!.tags?.subagent_id).toBe("call-sa-1");
    expect(agents[0]!.endNs).toBeDefined();
    expect(agents[0]!.endNs! >= agents[0]!.startNs).toBe(true);
  });

  test("nests under the open turn with turn_id tag for fanout rollup", async () => {
    const obs = createPerfReactorObserver();
    obs.observe(event("inference.start", { model: "m" }));
    obs.observe(
      event("inference.done", {
        turn: {
          role: "assistant",
          content: [{ type: "tool_call", id: "task-1", name: "task", arguments: {} }],
          model: "m",
          timestamp: 0,
        },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        source: { provider: "p", model: "m" },
      }),
    );
    const turnId = obs.currentTurnId();
    expect(turnId).not.toBeNull();

    const tool = createTaskTool({
      permissionGate: skipGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      run: async () => ({ report: "## Summary\n\nchild done\n" }),
    });
    if (tool.kind !== "full") throw new Error("expected full tool");

    await tool.handler(
      {
        id: "call-child",
        name: "task",
        arguments: { description: "Child", prompt: "Work", intent: "explore" },
      },
      new AbortController().signal,
    );

    const agent = byName(completed(snapshot()), "subagent")[0]!;
    expect(agent.parentId).toBe(turnId!);
    expect(agent.tags?.subagent_id).toBe("call-child");
    expect(agent.tags?.turn_id).toBe(turnId!);

    // Wall time under the child is attributable via parentId (fanout rollup).
    const turn = byName(snapshot(), "turn").find((s) => s.id === turnId);
    expect(turn).toBeDefined();
    expect(agent.startNs >= turn!.startNs).toBe(true);

    obs.reset();
  });

  test("closes the span when run() rejects", async () => {
    const tool = createTaskTool({
      permissionGate: skipGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      run: async () => {
        throw new Error("boom");
      },
    });
    if (tool.kind !== "full") throw new Error("expected full tool");

    const result = await tool.handler(
      {
        id: "call-fail",
        name: "task",
        arguments: { description: "Fail", prompt: "Work", intent: "explore" },
      },
      new AbortController().signal,
    );
    expect(typeof result.content === "string" ? result.content : "").toContain("Error:");

    const agents = byName(completed(snapshot()), "subagent");
    expect(agents).toHaveLength(1);
    expect(agents[0]!.tags?.subagent_id).toBe("call-fail");
    expect(agents[0]!.endNs).toBeDefined();
  });

  test("opens and closes subagent span when worktree setup fails before run", async () => {
    let runEntered = false;
    const tool = createTaskTool({
      permissionGate: skipGate,
      // Not a git repo — createSubAgentWorktree fails before run.
      cwd: "/tmp/not-a-git-repo-for-subagent-span",
      getWorkdirBase: () => "/tmp/not-a-git-repo-for-subagent-span/.corbits",
      provider,
      useWorktree: true,
      run: async () => {
        runEntered = true;
        return { report: "## Summary\n\nshould not run\n" };
      },
    });
    if (tool.kind !== "full") throw new Error("expected full tool");

    const result = await tool.handler(
      {
        id: "call-wt-fail",
        name: "task",
        arguments: { description: "Worktree fail", prompt: "Work", intent: "explore" },
      },
      new AbortController().signal,
    );
    expect(runEntered).toBe(false);
    expect(typeof result.content === "string" ? result.content : "").toContain("Error:");

    const agents = byName(completed(snapshot()), "subagent");
    expect(agents).toHaveLength(1);
    expect(agents[0]!.tags?.subagent_id).toBe("call-wt-fail");
    expect(agents[0]!.endNs).toBeDefined();
  });
});
