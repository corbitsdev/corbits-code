import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ToolCall } from "@intx/types/runtime";

import {
  looksLikeCodexShellArgs,
  prepareDispatchedToolCall,
} from "../agent/tool-aliases.js";
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

function hiddenShellArgvWorkdir(id: string, workdir: string): ToolCall {
  return {
    id,
    name: "shell",
    arguments: { command: ["bash", "-lc", DESTRUCTIVE], workdir },
  };
}

function countingDenyGate(reactorGated: boolean): {
  gate: ReturnType<typeof createPermissionGate>;
  asked: () => number;
} {
  let asked = 0;
  const gate = createPermissionGate({
    approvals: [],
    cwd: process.cwd(),
    requestApproval: async () => {
      asked++;
      return { allow: false };
    },
    interactive: true,
    skipPermissions: false,
    reactorGated,
  });
  return { gate, asked: () => asked };
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

describe("hidden-shell decline fingerprint (CL-9341)", () => {
  test("prepareDispatchedToolCall is idempotent on coerced run_shell", () => {
    const coerced = prepareDispatchedToolCall(
      hiddenShellArgv("idem-0"),
      "run_shell",
    );
    expect(coerced.name).toBe("run_shell");
    expect(coerced.arguments.command).toBe(DESTRUCTIVE);
    expect(prepareDispatchedToolCall(coerced, "run_shell")).toBe(coerced);
    const native: ToolCall = {
      id: "idem-native",
      name: "run_shell",
      arguments: { command: DESTRUCTIVE, cwd: "/tmp", timeout: 5 },
    };
    expect(prepareDispatchedToolCall(native, "run_shell")).toBe(native);
    expect(
      looksLikeCodexShellArgs({
        command: DESTRUCTIVE,
        cwd: "/tmp",
        timeout: 5,
      }),
    ).toBe(false);
    expect(
      looksLikeCodexShellArgs({ command: DESTRUCTIVE, workdir: "/tmp" }),
    ).toBe(true);
  });

  test("middleware hidden-shell-array decline suppresses the coerced retry with the identical reason", async () => {
    const { gate, asked } = countingDenyGate(false);
    const first = await gate.evaluate(hiddenShellArgv("shell-decline-1"));
    if (first.allowed) throw new Error("expected the hidden shell declined");
    expect(asked()).toBe(1);
    const coerced = prepareDispatchedToolCall(
      hiddenShellArgv("shell-decline-2"),
      "run_shell",
    );
    expect(coerced.arguments.command).toBe(DESTRUCTIVE);
    const retry = await gate.evaluate(coerced);
    if (retry.allowed)
      throw new Error("expected the coerced retry denied from denial memory");
    expect(asked()).toBe(1);
    expect(retry.reason).toBe(first.reason);
    const rawRetry = await gate.evaluate(hiddenShellArgv("shell-decline-3"));
    if (rawRetry.allowed)
      throw new Error("expected the raw retry denied from denial memory");
    expect(asked()).toBe(1);
    expect(rawRetry.reason).toBe(first.reason);
  });

  test("middleware hidden-shell workdir decline suppresses the cwd-coerced retry", async () => {
    // In-workspace so the coerced cwd clears path-escape and reaches the
    // operator (an outside-workspace workdir is denied outright, never
    // asked). Uncreated on disk: the gate never executes here.
    const workdir = join(process.cwd(), "tmp-corbits-decline-wd");
    const { gate, asked } = countingDenyGate(false);
    const first = await gate.evaluate(
      hiddenShellArgvWorkdir("shell-wd-1", workdir),
    );
    if (first.allowed)
      throw new Error("expected the hidden workdir shell declined");
    expect(asked()).toBe(1);
    const coerced = prepareDispatchedToolCall(
      hiddenShellArgvWorkdir("shell-wd-2", workdir),
      "run_shell",
    );
    expect(coerced.arguments).toEqual({ command: DESTRUCTIVE, cwd: workdir });
    const retry = await gate.evaluate(coerced);
    if (retry.allowed)
      throw new Error(
        "expected the cwd-coerced retry denied from denial memory",
      );
    expect(asked()).toBe(1);
    expect(retry.reason).toBe(first.reason);
  });

  test("reactor hidden-shell-array decline suppresses raw and coerced retries with the middleware-identical reason", async () => {
    const { gate, asked } = countingDenyGate(true);
    const suspended = await gate.authorizeCall(hiddenShellArgv("shell-r-1"));
    if (suspended.effect !== "ask")
      throw new Error("expected the hidden shell to suspend for approval");
    const outcome = await gate.resolveSuspended(suspended.request);
    expect(outcome?.allow).toBe(false);
    expect(asked()).toBe(1);
    const rawRetry = await gate.authorizeCall(hiddenShellArgv("shell-r-2"));
    if (rawRetry.effect !== "deny")
      throw new Error("expected the raw retry denied from denial memory");
    expect(asked()).toBe(1);
    const coercedRetry = await gate.authorizeCall(
      prepareDispatchedToolCall(hiddenShellArgv("shell-r-3"), "run_shell"),
    );
    if (coercedRetry.effect !== "deny")
      throw new Error("expected the coerced retry denied from denial memory");
    expect(asked()).toBe(1);
    expect(coercedRetry.reason).toBe(rawRetry.reason);
    const { gate: middleware } = countingDenyGate(false);
    const verdict = await middleware.evaluate(hiddenShellArgv("shell-r-4"));
    if (verdict.allowed)
      throw new Error("expected the middleware hidden shell declined");
    expect(rawRetry.reason).toBe(verdict.reason);
  });

  test("plain run_shell decline still suppresses the fresh-id retry", async () => {
    const { gate, asked } = countingDenyGate(false);
    const args = { command: DESTRUCTIVE };
    const first = await gate.evaluate({
      id: "shell-plain-1",
      name: "run_shell",
      arguments: args,
    });
    if (first.allowed) throw new Error("expected the plain shell declined");
    expect(asked()).toBe(1);
    const retry = await gate.evaluate({
      id: "shell-plain-2",
      name: "run_shell",
      arguments: args,
    });
    if (retry.allowed)
      throw new Error("expected the plain retry denied from denial memory");
    expect(asked()).toBe(1);
    expect(retry.reason).toBe(first.reason);
  });
});
