import { expect, test } from "bun:test";
import { createPermissionGate } from "./gate.js";
import { createReactorAuthorize, createWorkerAuthorize } from "./reactor-authorize.js";
import { runWithSubAgentIdentity, getSubAgentIdentity } from "../subagent/identity-context.js";
import { gateToolCall } from "../plugins/permission-plugin.js";
import type { ToolCall } from "@intx/types/runtime";

const call: ToolCall = {
  id: "write-1",
  name: "write_file",
  arguments: { path: "probe.txt", content: "data" },
};
const gate = () =>
  createPermissionGate({
    cwd: process.cwd(),
    approvals: [],
    interactive: true,
    auto: false,
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
  policy.setAuto(true);
  expect((await createWorkerAuthorize(policy)("tool:write_file", "invoke", call)).effect).toBe(
    "allow",
  );
  policy.setAuto(false);
  expect((await createWorkerAuthorize(policy)("tool:write_file", "invoke", call)).effect).toBe(
    "deny",
  );
});

test("worker bridge rejects malformed context, resource, and action", async () => {
  const authorize = createWorkerAuthorize(gate());
  await expect(authorize("tool:write_file", "invoke", {})).rejects.toThrow("ToolCall");
  await expect(authorize("tool:read_file", "invoke", call)).rejects.toThrow("does not match");
  await expect(authorize("tool:write_file", "read", call)).rejects.toThrow("unexpected action");
});

test("worker reactor is sole owner even if parent middleware mode changes policy before runner", async () => {
  const policy = gate();
  policy.setAuto(true);
  const identity = { description: "worker", cwd: process.cwd(), reactorOwnsPermissions: true };
  const authorize = createWorkerAuthorize(policy);
  expect(
    (await runWithSubAgentIdentity(identity, () => authorize("tool:write_file", "invoke", call)))
      .effect,
  ).toBe("allow");
  policy.setAuto(false);
  const result = await runWithSubAgentIdentity(identity, () =>
    gateToolCall(policy, call, new AbortController().signal, async () => ({
      callId: call.id,
      content: "executed",
      isError: false,
    })),
  );
  expect(result.isError).toBe(false);
  expect(policy.isReactorGated()).toBe(false);
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
      runWithSubAgentIdentity({ description: cwd, cwd, reactorOwnsPermissions: true }, () =>
        authorize("tool:write_file", "invoke", call),
      ),
    ),
  );
  expect(seen.sort()).toEqual(["/worker-a", "/worker-b"]);
  expect(getSubAgentIdentity()).toBeUndefined();
});
