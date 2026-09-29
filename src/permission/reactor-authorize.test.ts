import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthzExtension } from "@intx/inference";
import type {
  ToolDefinition,
  ReactorState,
  TokenUsage,
} from "@intx/types/runtime";
import { createPermissionGate } from "./gate.js";
import {
  createReactorAuthorize,
  createWorkerAuthorize,
  workerPermissionGate,
} from "./reactor-authorize.js";
import { authzParityDefinitions } from "../agent/tool-aliases.js";
import {
  runWithSubAgentIdentity,
  getSubAgentIdentity,
} from "../subagent/identity-context.js";
import { gateToolCall } from "../plugins/permission-plugin.js";
import { WORKER_CANNOT_COMPLETE_APPROVAL } from "./decline-markers.js";
import type { ToolCall } from "@intx/types/runtime";

const call: ToolCall = {
  id: "write-1",
  name: "write_file",
  arguments: { path: "probe.txt", content: "data" },
};
const namedCall = (
  name: string,
  args: Record<string, unknown> = {},
): ToolCall => ({
  id: `${name}-1`,
  name,
  arguments: args,
});
const gate = (opts?: { interactive?: boolean; auto?: boolean }) =>
  createPermissionGate({
    cwd: process.cwd(),
    approvals: [],
    interactive: opts?.interactive ?? true,
    auto: opts?.auto ?? false,
    skipPermissions: false,
    reactorGated: false,
    requestApproval: async () => {
      throw new Error("worker must never ask");
    },
  });

test("worker grant after a denied write allows a later call id through gateToolCall", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-grant-"));
  const path = join(cwd, "probe.txt");
  const policy = createPermissionGate({
    cwd,
    approvals: [],
    interactive: false,
    auto: false,
    skipPermissions: false,
    reactorGated: true,
    requestApproval: async () => {
      throw new Error("worker must never ask");
    },
  });
  const workerGate = workerPermissionGate(policy);
  const first: ToolCall = {
    id: "call_auto_0",
    name: "write_file",
    arguments: { path, content: "unauthorized" },
  };
  const second: ToolCall = {
    id: "call_auto_1",
    name: "write_file",
    arguments: { path, content: "unauthorized" },
  };
  expect((await workerGate.authorizeCall(first)).effect).toBe("deny");
  policy.setSeededApprovals([{ tool: "write_file", pattern: path }]);
  expect((await workerGate.authorizeCall(second)).effect).toBe("allow");
  let called = false;
  const result = await gateToolCall(
    workerGate,
    second,
    new AbortController().signal,
    async () => {
      called = true;
      return { callId: second.id, content: "executed", isError: false };
    },
  );
  expect(result.isError).toBe(false);
  expect(called).toBe(true);
});

test("worker grant survives pathEscape realpath rewrite through gateToolCall", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-grant-realpath-"));
  const lexical = join(cwd, "probe.txt");
  const escaped = join(realpathSync(cwd), "probe.txt");
  const policy = createPermissionGate({
    cwd,
    approvals: [{ tool: "write_file", pattern: lexical }],
    interactive: false,
    auto: false,
    skipPermissions: false,
    reactorGated: true,
    requestApproval: async () => {
      throw new Error("worker must never ask");
    },
  });
  const workerGate = workerPermissionGate(policy);
  const authorized: ToolCall = {
    id: "call_auto_0",
    name: "write_file",
    arguments: { path: lexical, content: "unauthorized" },
  };
  const executed: ToolCall = {
    id: "call_auto_0",
    name: "write_file",
    arguments: { path: escaped, content: "unauthorized" },
  };
  expect((await workerGate.authorizeCall(authorized)).effect).toBe("allow");
  let called = false;
  const result = await gateToolCall(
    workerGate,
    executed,
    new AbortController().signal,
    async () => {
      called = true;
      return { callId: executed.id, content: "executed", isError: false };
    },
  );
  expect(result.isError).toBe(false);
  expect(called).toBe(true);
});

test("worker maps unresolved ask to deny while main reactor suspends", async () => {
  const policy = gate();
  expect(
    (await createReactorAuthorize(policy)("tool:write_file", "invoke", call))
      .effect,
  ).toBe("ask");
  expect(
    (await createWorkerAuthorize(policy)("tool:write_file", "invoke", call))
      .effect,
  ).toBe("deny");
  const denied = await workerPermissionGate(policy).authorizeCall(call);
  expect(denied.effect).toBe("deny");
  if (denied.effect !== "deny") throw new Error("expected deny");
  expect(denied.reason).toContain("probe.txt");
  expect(denied.reason).toContain(WORKER_CANNOT_COMPLETE_APPROVAL);
  const workerDenied = await createWorkerAuthorize(policy)(
    "tool:write_file",
    "invoke",
    call,
  );
  expect(workerDenied.effect).toBe("deny");
  expect(workerDenied.reason).toBe(denied.reason);
  policy.setAuto(true);
  expect(
    (await createWorkerAuthorize(policy)("tool:write_file", "invoke", call))
      .effect,
  ).toBe("allow");
  policy.setAuto(false);
  expect(
    (await createWorkerAuthorize(policy)("tool:write_file", "invoke", call))
      .effect,
  ).toBe("deny");
});

test("leaf worker control-plane tools allow with empty parent approvals", async () => {
  for (const mode of [
    { interactive: true, auto: false },
    { interactive: false, auto: true },
  ] as const) {
    const policy = gate(mode);
    const authorize = createWorkerAuthorize(policy);
    expect(
      (
        await authorize(
          "tool:submit_result",
          "invoke",
          namedCall("submit_result"),
        )
      ).effect,
    ).toBe("allow");
    expect(
      (
        await authorize(
          "tool:ask_director",
          "invoke",
          namedCall("ask_director"),
        )
      ).effect,
    ).toBe("allow");
    expect(
      (
        await authorize(
          "tool:default.submit_result",
          "invoke",
          namedCall("default.submit_result"),
        )
      ).effect,
    ).toBe("allow");
    expect(
      (
        await authorize(
          "tool:default.ask_director",
          "invoke",
          namedCall("default.ask_director"),
        )
      ).effect,
    ).toBe("allow");
    expect(
      (await authorize("tool:wait_agents", "invoke", namedCall("wait_agents")))
        .effect,
    ).toBe("allow");
  }
});

test("nested orchestrator wait_agents allows with only a spawn_agent grant", async () => {
  const policy = gate({ interactive: true, auto: false });
  policy.setSeededApprovals([{ tool: "spawn_agent", pattern: "*" }]);
  const authorize = createWorkerAuthorize(policy);
  expect(
    (await authorize("tool:wait_agents", "invoke", namedCall("wait_agents")))
      .effect,
  ).toBe("allow");
  expect(
    (await authorize("tool:list_agents", "invoke", namedCall("list_agents")))
      .effect,
  ).toBe("allow");
  expect(
    (await authorize("tool:spawn_agent", "invoke", namedCall("spawn_agent")))
      .effect,
  ).toBe("allow");
});

test("worker spawn_agent still needs a parent grant", async () => {
  const policy = gate({ interactive: true, auto: false });
  expect(
    (
      await createWorkerAuthorize(policy)(
        "tool:spawn_agent",
        "invoke",
        namedCall("spawn_agent"),
      )
    ).effect,
  ).toBe("deny");
});

test("worker authorizeCall never emits ask", async () => {
  const policy = gate({ interactive: true, auto: false });
  expect(
    (await workerPermissionGate(policy).authorizeCall(call)).effect,
  ).not.toBe("ask");
  expect((await policy.authorizeCall(call)).effect).toBe("ask");
});

test("worker bridge rejects malformed context, resource, and action", async () => {
  const authorize = createWorkerAuthorize(gate());
  await expect(authorize("tool:write_file", "invoke", {})).rejects.toThrow(
    "ToolCall",
  );
  await expect(authorize("tool:read_file", "invoke", call)).rejects.toThrow(
    "does not match",
  );
  await expect(authorize("tool:write_file", "read", call)).rejects.toThrow(
    "unexpected action",
  );
});

test("worker gateToolCall blocks unresolved ask on cache miss", async () => {
  const policy = gate();
  const workerGate = workerPermissionGate(policy);
  let called = false;
  const result = await gateToolCall(
    workerGate,
    call,
    new AbortController().signal,
    async () => {
      called = true;
      return { callId: call.id, content: "executed", isError: false };
    },
  );
  expect(result.isError).toBe(true);
  expect(called).toBe(false);
  expect(workerGate.isReactorGated()).toBe(true);
});

test("worker reactor is sole owner even if parent middleware mode changes policy before runner", async () => {
  const policy = gate();
  policy.setAuto(true);
  const identity = { description: "worker", cwd: process.cwd() };
  const workerGate = workerPermissionGate(policy);
  const authorize = createWorkerAuthorize(policy);
  expect(
    (
      await runWithSubAgentIdentity(identity, () =>
        authorize("tool:write_file", "invoke", call),
      )
    ).effect,
  ).toBe("allow");
  policy.setAuto(false);
  const result = await runWithSubAgentIdentity(identity, () =>
    gateToolCall(workerGate, call, new AbortController().signal, async () => ({
      callId: call.id,
      content: "executed",
      isError: false,
    })),
  );
  expect(result.isError).toBe(false);
  expect(policy.isReactorGated()).toBe(false);
  expect(workerGate.isReactorGated()).toBe(true);
  expect(
    (
      await runWithSubAgentIdentity(identity, () =>
        authorize("tool:write_file", "invoke", call),
      )
    ).effect,
  ).toBe("deny");
  expect(getSubAgentIdentity()).toBeUndefined();
});

test("concurrent authorization preserves each worker cwd across awaited policy evaluation", async () => {
  const policy = gate();
  const seen: string[] = [];
  const realAuthorize = policy.authorizeCall;
  policy.authorizeCall = async (toolCall) => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    const identity = getSubAgentIdentity();
    if (identity === undefined) throw new Error("missing worker identity");
    seen.push(identity.cwd);
    return realAuthorize(toolCall);
  };
  const authorize = createWorkerAuthorize(policy);
  await Promise.all(
    ["/worker-a", "/worker-b"].map((cwd) =>
      runWithSubAgentIdentity({ description: cwd, cwd }, () =>
        authorize("tool:write_file", "invoke", call),
      ),
    ),
  );
  expect(seen.sort()).toEqual(["/worker-a", "/worker-b"]);
  expect(getSubAgentIdentity()).toBeUndefined();
});

const shellDef = (name: string): ToolDefinition => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object", properties: {} },
});

const emptyUsage = (): TokenUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
});

const askState = (): ReactorState => ({
  sessionId: "parity-ask",
  turns: [],
  activeForks: [],
  pendingOperations: [],
  activeGates: [],
  tokenUsage: emptyUsage(),
  lastCycleUsage: null,
  lastCycleSource: null,
});

const askSignal = new AbortController().signal;

test("ask-tier shell aliases suspend with a wire-named snapshot", async () => {
  const policy = gate({ interactive: true });
  const ext = createAuthzExtension({
    toolDefinitions: authzParityDefinitions([
      shellDef("run_shell"),
      shellDef("read_file"),
    ]),
    authorize: createReactorAuthorize(policy),
  });
  for (const name of ["bash", "run_shell", "shell"]) {
    const toolCall = namedCall(name, { command: "sleep 30" });
    const outcome = await ext.beforeTool(toolCall, askState(), askSignal);
    if (outcome.type !== "suspend") throw new Error(`expected ${name} to park`);
    expect(outcome.pendingOp.approvalSnapshot?.name).toBe(name);
    expect(outcome.pendingOp.approvalSnapshot?.arguments).toEqual({
      command: "sleep 30",
    });
    expect(outcome.pendingOp.suspendedCall).toEqual(toolCall);
  }
});

test("seeded run_shell grant allows bash, run_shell, and shell", async () => {
  const policy = gate({ interactive: true });
  policy.setSeededApprovals([{ tool: "run_shell", pattern: "echo *" }]);
  const ext = createAuthzExtension({
    toolDefinitions: authzParityDefinitions([shellDef("run_shell")]),
    authorize: createReactorAuthorize(policy),
  });
  for (const name of ["bash", "run_shell", "shell"]) {
    const outcome = await ext.beforeTool(
      namedCall(name, { command: "echo hi" }),
      askState(),
      askSignal,
    );
    expect(outcome.type).toBe("allow");
  }
});

test("ask on a tool missing from the resolved set still throws", async () => {
  const policy = gate({ interactive: true });
  const ext = createAuthzExtension({
    toolDefinitions: authzParityDefinitions([shellDef("read_file")]),
    authorize: createReactorAuthorize(policy),
  });
  await expect(
    ext.beforeTool(
      namedCall("bash", { command: "sleep 30" }),
      askState(),
      askSignal,
    ),
  ).rejects.toThrow(/wiring defect/);
});

test("approved ask resumes the exact parked call once via one-shot bypass", async () => {
  const policy = gate({ interactive: true });
  const reactorAuthorize = createReactorAuthorize(policy);
  const seen: ToolCall[] = [];
  const ext = createAuthzExtension<ToolCall>({
    toolDefinitions: authzParityDefinitions([shellDef("run_shell")]),
    authorize: (resource, action, call) => {
      seen.push(call);
      return reactorAuthorize(resource, action, call);
    },
  });
  for (const name of ["bash", "run_shell"]) {
    const toolCall = namedCall(name, { command: "sleep 30" });
    const parked = await ext.beforeTool(toolCall, askState(), askSignal);
    if (parked.type !== "suspend") throw new Error(`expected ${name} to park`);
    expect(parked.pendingOp.approvalSnapshot?.name).toBe(name);
    ext.grantOneShot?.(toolCall.id);
    const resumed = await ext.beforeTool(toolCall, askState(), askSignal);
    expect(resumed.type).toBe("allow");
    expect(seen[seen.length - 1]).toEqual(parked.pendingOp.suspendedCall);
    const reparked = await ext.beforeTool(toolCall, askState(), askSignal);
    expect(reparked.type).toBe("suspend");
  }
});

test("denied shell call blocks with a policy error", async () => {
  const policy = gate({ interactive: false });
  const ext = createAuthzExtension({
    toolDefinitions: authzParityDefinitions([shellDef("run_shell")]),
    authorize: createReactorAuthorize(policy),
  });
  for (const name of ["bash", "run_shell"]) {
    const outcome = await ext.beforeTool(
      namedCall(name, { command: "sleep 30" }),
      askState(),
      askSignal,
    );
    if (outcome.type !== "block") throw new Error(`expected ${name} to block`);
    expect(outcome.reason).toMatch(/Denied by policy/);
  }
});
