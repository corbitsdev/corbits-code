import { expect, test } from "bun:test";
import { createPermissionGate } from "./gate.js";
import {
  createReactorAuthorize,
  createWorkerAuthorize,
  workerPermissionGate,
} from "./reactor-authorize.js";
import { runWithSubAgentIdentity, getSubAgentIdentity } from "../subagent/identity-context.js";
import { gateToolCall } from "../plugins/permission-plugin.js";
import { WORKER_CANNOT_COMPLETE_APPROVAL } from "./decline-markers.js";
import type { ToolCall } from "@intx/types/runtime";

const call: ToolCall = {
  id: "write-1",
  name: "write_file",
  arguments: { path: "probe.txt", content: "data" },
};
const namedCall = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
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

test("worker maps unresolved ask to deny while main reactor suspends", async () => {
  const policy = gate();
  expect((await createReactorAuthorize(policy)("tool:write_file", "invoke", call)).effect).toBe(
    "ask",
  );
  expect((await createWorkerAuthorize(policy)("tool:write_file", "invoke", call)).effect).toBe(
    "deny",
  );
  const denied = await workerPermissionGate(policy).authorizeCall(call);
  expect(denied.effect).toBe("deny");
  if (denied.effect !== "deny") throw new Error("expected deny");
  expect(denied.reason).toContain("probe.txt");
  expect(denied.reason).toContain(WORKER_CANNOT_COMPLETE_APPROVAL);
  const workerDenied = await createWorkerAuthorize(policy)("tool:write_file", "invoke", call);
  expect(workerDenied.effect).toBe("deny");
  expect(workerDenied.reason).toBe(denied.reason);
  policy.setAuto(true);
  expect((await createWorkerAuthorize(policy)("tool:write_file", "invoke", call)).effect).toBe(
    "allow",
  );
  policy.setAuto(false);
  expect((await createWorkerAuthorize(policy)("tool:write_file", "invoke", call)).effect).toBe(
    "deny",
  );
});

test("leaf worker control-plane tools allow with empty parent approvals", async () => {
  for (const mode of [
    { interactive: true, auto: false },
    { interactive: false, auto: true },
  ] as const) {
    const policy = gate(mode);
    const authorize = createWorkerAuthorize(policy);
    expect(
      (await authorize("tool:submit_result", "invoke", namedCall("submit_result"))).effect,
    ).toBe("allow");
    expect((await authorize("tool:ask_director", "invoke", namedCall("ask_director"))).effect).toBe(
      "allow",
    );
    expect((await authorize("tool:wait_agents", "invoke", namedCall("wait_agents"))).effect).toBe(
      "allow",
    );
  }
});

test("nested orchestrator wait_agents allows with only a spawn_agent grant", async () => {
  const policy = gate({ interactive: true, auto: false });
  policy.setSeededApprovals([{ tool: "spawn_agent", pattern: "*" }]);
  const authorize = createWorkerAuthorize(policy);
  expect((await authorize("tool:wait_agents", "invoke", namedCall("wait_agents"))).effect).toBe(
    "allow",
  );
  expect((await authorize("tool:list_agents", "invoke", namedCall("list_agents"))).effect).toBe(
    "allow",
  );
  expect((await authorize("tool:spawn_agent", "invoke", namedCall("spawn_agent"))).effect).toBe(
    "allow",
  );
});

test("worker spawn_agent still needs a parent grant", async () => {
  const policy = gate({ interactive: true, auto: false });
  expect(
    (await createWorkerAuthorize(policy)("tool:spawn_agent", "invoke", namedCall("spawn_agent")))
      .effect,
  ).toBe("deny");
});

test("worker authorizeCall never emits ask", async () => {
  const policy = gate({ interactive: true, auto: false });
  expect((await workerPermissionGate(policy).authorizeCall(call)).effect).not.toBe("ask");
  expect((await policy.authorizeCall(call)).effect).toBe("ask");
});

test("worker bridge rejects malformed context, resource, and action", async () => {
  const authorize = createWorkerAuthorize(gate());
  await expect(authorize("tool:write_file", "invoke", {})).rejects.toThrow("ToolCall");
  await expect(authorize("tool:read_file", "invoke", call)).rejects.toThrow("does not match");
  await expect(authorize("tool:write_file", "read", call)).rejects.toThrow("unexpected action");
});

test("worker gateToolCall blocks unresolved ask on cache miss", async () => {
  const policy = gate();
  const workerGate = workerPermissionGate(policy);
  let called = false;
  const result = await gateToolCall(workerGate, call, new AbortController().signal, async () => {
    called = true;
    return { callId: call.id, content: "executed", isError: false };
  });
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
    (await runWithSubAgentIdentity(identity, () => authorize("tool:write_file", "invoke", call)))
      .effect,
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
    (await runWithSubAgentIdentity(identity, () => authorize("tool:write_file", "invoke", call)))
      .effect,
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
