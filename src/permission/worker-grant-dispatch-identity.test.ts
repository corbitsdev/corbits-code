// gpt-family workers call run_shell as `shell` with run_shell's own
// arguments. Reactor authz sees that raw wire call; the permission
// middleware sees prepareDispatchedToolCall, which renames `shell` to
// `run_shell` and leaves cwd, timeout, background, and stop in place.
// The authorized retry must match the same envelope at both stages.
import { describe, expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import { prepareDispatchedToolCall } from "../agent/tool-aliases.js";
import { gateToolCall } from "../plugins/permission-plugin.js";
import { createPermissionGate } from "./gate.js";
import { workerPermissionGate } from "./reactor-authorize.js";
import { WorkerGrantStore } from "./worker-grant.js";

const CWD = process.cwd();

// The call shape a gpt-family worker sends for run_shell.
const wireCall = (id: string): ToolCall => ({
  id,
  name: "shell",
  arguments: {
    command: "git status --short",
    timeout: 120000,
    cwd: CWD,
    background: false,
    stop: "",
  },
});

function extractRequestId(reason: string): string {
  const match = /grant request ([0-9a-f-]{36})/.exec(reason);
  if (match?.[1] === undefined) throw new Error(`no grant id: ${reason}`);
  return match[1];
}

describe("gpt-family worker authorized retry identity", () => {
  test("approved retry of a `shell` call executes once instead of minting a new grant request", async () => {
    // Parent: reactor-gated interactive gate, nothing pre-approved, no auto.
    const parentGate = createPermissionGate({
      approvals: [],
      cwd: CWD,
      skipPermissions: false,
      interactive: true,
      reactorGated: true,
      auto: false,
      requestApproval: async () => ({ allow: false }),
    });
    const store = new WorkerGrantStore();
    const workerGate = workerPermissionGate(parentGate, {
      sessionId: "worker-gpt",
      store,
    });

    // 1. First attempt: reactor authz denies and records envelope A.
    const denied = await workerGate.authorizeCall(wireCall("call-1"));
    if (denied.effect !== "deny") throw new Error("expected worker deny");
    const requestId = extractRequestId(denied.reason);
    const envelope = store.peek(requestId);
    expect(envelope?.canonicalTool).toBe("run_shell");

    // 2. approve_worker_call: parent approved the frozen call (allow-once,
    // no session grant) and flipped the envelope to authorized.
    expect(store.authorizeRetry(requestId)).toBe(true);

    // 3. Retry, stage 1: reactor authz on the raw wire call allows via
    // hasAuthorizedRetry (does not consume).
    const retryAuthz = await workerGate.authorizeCall(wireCall("call-2"));
    expect(retryAuthz).toEqual({ effect: "allow" });
    expect(store.peek(requestId)?.status).toBe("authorized");

    // 4. Retry, stage 2: DynamicToolRunner renames `shell` onto run_shell
    // and keeps the gpt-native arguments, then the posix middleware runs
    // gateToolCall. The grant still matches the authorized envelope.
    const dispatched = prepareDispatchedToolCall(
      wireCall("call-2"),
      "run_shell",
    );
    expect(dispatched.name).toBe("run_shell");
    expect(dispatched.arguments).toEqual(wireCall("x").arguments);
    expect(dispatched.arguments).toMatchObject({
      cwd: CWD,
      timeout: 120000,
      background: false,
      stop: "",
    });

    let executed = 0;
    const result = await gateToolCall(
      workerGate,
      dispatched,
      new AbortController().signal,
      async (call) => {
        executed++;
        return { callId: call.id, content: "ran" };
      },
    );

    expect(result.isError).not.toBe(true);
    expect(executed).toBe(1);
    expect(store.peek(requestId)?.status).toBe("consumed");

    // One grant, one execution: a replay of the same call fails closed at
    // both stages, and no second envelope was minted.
    const replay = await gateToolCall(
      workerGate,
      prepareDispatchedToolCall(wireCall("call-3"), "run_shell"),
      new AbortController().signal,
      async (call) => {
        executed++;
        return { callId: call.id, content: "ran" };
      },
    );
    expect(replay.isError).toBe(true);
    expect(String(replay.content)).toContain("already consumed");
    expect((await workerGate.authorizeCall(wireCall("call-4"))).effect).toBe(
      "deny",
    );
    expect(executed).toBe(1);
  });

  test("an altered retry (different command) still fails closed", async () => {
    const parentGate = createPermissionGate({
      approvals: [],
      cwd: CWD,
      skipPermissions: false,
      interactive: true,
      reactorGated: true,
      auto: false,
      requestApproval: async () => ({ allow: false }),
    });
    const store = new WorkerGrantStore();
    const workerGate = workerPermissionGate(parentGate, {
      sessionId: "worker-gpt-alt",
      store,
    });
    const denied = await workerGate.authorizeCall(wireCall("call-1"));
    if (denied.effect !== "deny") throw new Error("expected worker deny");
    const requestId = extractRequestId(denied.reason);
    expect(store.authorizeRetry(requestId)).toBe(true);

    const altered: ToolCall = {
      ...wireCall("call-2"),
      arguments: { ...wireCall("x").arguments, command: "git push --force" },
    };
    expect((await workerGate.authorizeCall(altered)).effect).toBe("deny");
    const result = await gateToolCall(
      workerGate,
      prepareDispatchedToolCall(altered, "run_shell"),
      new AbortController().signal,
      async (call) => ({ callId: call.id, content: "ran" }),
    );
    expect(result.isError).toBe(true);
    expect(store.peek(requestId)?.status).toBe("authorized");
  });
});
