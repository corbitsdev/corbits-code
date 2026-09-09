import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { APPROVAL_LOG_FILE, createApprovalLog } from "../permission/approval-log.js";
import { BLOCKED_BY_POLICY_PREFIX } from "../permission/decline-markers.js";
import { createPermissionGate } from "../permission/gate.js";
import { gateToolCall, permissionPlugin } from "./permission-plugin.js";

function shellCall(command: string): ToolCall {
  return {
    id: "test-call",
    name: "run_shell",
    arguments: { command },
  };
}

function trackingNext() {
  let called = false;
  const next = async (call: ToolCall, _signal: AbortSignal): Promise<ToolResult> => {
    called = true;
    return { callId: call.id, content: "ok" };
  };
  return {
    next,
    wasCalled: () => called,
  };
}

function readApprovalRecords(dir: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, APPROVAL_LOG_FILE), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("gateToolCall", () => {
  test("reactor-gated authz hard-deny blocks and skips next", async () => {
    const gate = createPermissionGate({
      approvals: [],
      interactive: false,
      skipPermissions: false,
      reactorGated: true,
    });
    const { next, wasCalled } = trackingNext();
    const result = await gateToolCall(
      gate,
      shellCall("rm -rf /"),
      new AbortController().signal,
      next,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(BLOCKED_BY_POLICY_PREFIX);
    expect(wasCalled()).toBe(false);
  });

  test("reactor-gated auto-shell deny blocks without asking", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [],
      interactive: true,
      skipPermissions: false,
      reactorGated: true,
      auto: true,
      requestApproval: async () => {
        asked++;
        return { allow: true };
      },
    });
    const { next, wasCalled } = trackingNext();
    const result = await gateToolCall(
      gate,
      shellCall("echo x | tee src/a.ts"),
      new AbortController().signal,
      next,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(BLOCKED_BY_POLICY_PREFIX);
    expect(wasCalled()).toBe(false);
    expect(asked).toBe(0);
  });

  test("reactor-gated headless deny blocks and skips next", async () => {
    const gate = createPermissionGate({
      approvals: [],
      interactive: false,
      skipPermissions: false,
      reactorGated: true,
    });
    const { next, wasCalled } = trackingNext();
    const result = await gateToolCall(
      gate,
      shellCall("curl https://example.com"),
      new AbortController().signal,
      next,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(BLOCKED_BY_POLICY_PREFIX);
    expect(wasCalled()).toBe(false);
  });

  test("reactor-gated ask skips the prompt and still calls next", async () => {
    const gate = createPermissionGate({
      approvals: [],
      interactive: true,
      skipPermissions: false,
      reactorGated: true,
      requestApproval: async () => {
        throw new Error("requestApproval must not be invoked under reactor gating");
      },
    });
    const { next, wasCalled } = trackingNext();
    const result = await gateToolCall(
      gate,
      shellCall("curl https://example.com"),
      new AbortController().signal,
      next,
    );
    expect(result.isError).not.toBe(true);
    expect(wasCalled()).toBe(true);
  });

  test("reactor-gated allow-tier still calls next", async () => {
    const gate = createPermissionGate({
      approvals: [],
      interactive: false,
      skipPermissions: false,
      reactorGated: true,
    });
    const { next, wasCalled } = trackingNext();
    const result = await gateToolCall(
      gate,
      { id: "test-call", name: "read_file", arguments: { path: "src/a.ts" } },
      new AbortController().signal,
      next,
    );
    expect(result.isError).not.toBe(true);
    expect(wasCalled()).toBe(true);
  });

  test("reactor-gated auto-allow records once across authorizeCall then gateToolCall", async () => {
    const dir = mkdtempSync(join(tmpdir(), "approval-log-reactor-"));
    const cwd = mkdtempSync(join(tmpdir(), "gate-cwd-"));
    const gate = createPermissionGate({
      approvals: [],
      interactive: true,
      skipPermissions: false,
      reactorGated: true,
      auto: true,
      cwd,
      approvalLog: createApprovalLog(dir),
      requestApproval: async () => {
        throw new Error("requestApproval must not be invoked under reactor gating");
      },
    });
    const call: ToolCall = {
      id: "write-1",
      name: "write_file",
      arguments: { path: "src/a.ts", content: "x" },
    };
    const first = await gate.authorizeCall(call);
    expect(first.effect).toBe("allow");
    const { next, wasCalled } = trackingNext();
    const result = await gateToolCall(gate, call, new AbortController().signal, next);
    expect(result.isError).not.toBe(true);
    expect(wasCalled()).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    const records = readApprovalRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0]?.outcome).toBe("auto-allow");
  });

  test("sub-agent path still evaluates and denies authz hard-deny", async () => {
    const gate = createPermissionGate({
      approvals: [],
      interactive: false,
      skipPermissions: false,
      reactorGated: false,
    });
    const { next, wasCalled } = trackingNext();
    const result = await gateToolCall(
      gate,
      shellCall("rm -rf /"),
      new AbortController().signal,
      next,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(BLOCKED_BY_POLICY_PREFIX);
    expect(wasCalled()).toBe(false);
  });
});

describe("permissionPlugin", () => {
  test("middleware blocks reactor-gated authz hard-deny", async () => {
    const gate = createPermissionGate({
      approvals: [],
      interactive: false,
      skipPermissions: false,
      reactorGated: true,
    });
    const { next, wasCalled } = trackingNext();
    const plugin = permissionPlugin(gate);
    const handler = plugin.middleware ? plugin.middleware(next) : next;
    const result = await handler(shellCall("rm -rf /"), new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(BLOCKED_BY_POLICY_PREFIX);
    expect(wasCalled()).toBe(false);
  });
});
