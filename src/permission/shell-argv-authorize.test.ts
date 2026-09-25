import { describe, expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import { prepareDispatchedToolCall } from "../agent/tool-aliases.js";
import { gateToolCall } from "../plugins/permission-plugin.js";
import { BLOCKED_BY_POLICY_PREFIX } from "./decline-markers.js";
import { createPermissionGate } from "./gate.js";
import { workerPermissionGate } from "./reactor-authorize.js";

const DESTRUCTIVE = "rm -rf node_modules";

function hiddenShellArgv(id: string): ToolCall {
  return {
    id,
    name: "shell",
    arguments: { command: ["bash", "-lc", DESTRUCTIVE] },
  };
}

describe("reactor-gated hidden shell argv coerce-before-authorize", () => {
  test("command string[] does not auto-allow; unwrapped script is the ask subject; ask does not execute", async () => {
    const gate = createPermissionGate({
      approvals: [],
      cwd: process.cwd(),
      requestApproval: async () => ({ allow: false }),
      interactive: true,
      skipPermissions: false,
      reactorGated: true,
    });
    const call = hiddenShellArgv("shell-argv-1");
    const authorized = await gate.authorizeCall(call);
    expect(authorized.effect).not.toBe("allow");
    expect(authorized.effect).toBe("ask");
    if (authorized.effect === "ask") {
      expect(authorized.request.subject).toBe(DESTRUCTIVE);
      expect(authorized.request.tool).toBe("run_shell");
    }

    const coerced = prepareDispatchedToolCall(call, "run_shell");
    expect(coerced.arguments.command).toBe(DESTRUCTIVE);
    const executed = await gate.executionVerdict(coerced);
    expect(executed.effect).toBe("ask");

    const worker = workerPermissionGate(gate);
    const workerCall = hiddenShellArgv("shell-argv-worker");
    expect((await worker.authorizeCall(workerCall)).effect).toBe("deny");
    const workerCoerced = prepareDispatchedToolCall(workerCall, "run_shell");
    let nextCalled = false;
    const result = await gateToolCall(
      worker,
      workerCoerced,
      new AbortController().signal,
      async () => {
        nextCalled = true;
        return { callId: workerCall.id, content: "ran" };
      },
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain(BLOCKED_BY_POLICY_PREFIX);
    expect(nextCalled).toBe(false);
  });
});
