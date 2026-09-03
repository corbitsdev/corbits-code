/**
 * Pure notice formatting + emitter payload validation.
 */
import { describe, expect, test } from "bun:test";

import {
  compactionFoldInfo,
  compactionNotice,
  grantApproval,
  grantNotice,
  hookNotice,
  lifecycleHookEvent,
  mcpNotice,
  mcpServerState,
  subAgentProgress,
} from "./runtime-notices.js";

const hook = {
  id: "fmt",
  name: "format",
  type: "shell" as const,
  path: "/hooks/format.sh",
  enabled: true,
};

describe("hookNotice", () => {
  test("startup inventory says nothing", () => {
    expect(hookNotice({ type: "hooks.loaded", hooks: [hook] })).toBeNull();
  });

  test("a hook that has not fired says nothing", () => {
    expect(hookNotice({ type: "hook.updated", hook })).toBeNull();
  });

  test("a clean run is a flash", () => {
    expect(
      hookNotice({
        type: "hook.updated",
        hook: {
          ...hook,
          lastFiredAt: 1,
          lastExitStatus: { code: 0, signal: null, stderr: "" },
        },
      }),
    ).toEqual({ kind: "flash", text: "hook format ran" });
  });

  test("a failed run is a row carrying the exit and the way out", () => {
    const notice = hookNotice({
      type: "hook.updated",
      hook: {
        ...hook,
        lastFiredAt: 1,
        lastExitStatus: { code: 2, signal: null, stderr: "prettier not found\n" },
      },
    });
    expect(notice).toEqual({
      kind: "row",
      text: "hook format failed (exit 2): prettier not found — /hooks to disable it",
    });
  });

  test("a signalled run names the signal", () => {
    const notice = hookNotice({
      type: "hook.updated",
      hook: {
        ...hook,
        lastFiredAt: 1,
        lastExitStatus: { code: null, signal: "SIGKILL", stderr: "" },
      },
    });
    expect(notice?.kind).toBe("row");
    expect(notice?.text).toContain("failed (SIGKILL)");
  });
});

describe("mcpNotice", () => {
  test("connecting is not news", () => {
    expect(mcpNotice({ name: "linear", state: "connecting" })).toBeNull();
  });

  test("connected flashes with a tool count", () => {
    expect(mcpNotice({ name: "linear", state: "connected", tools: ["a", "b"] })).toEqual({
      kind: "flash",
      text: "mcp linear connected · 2 tools",
    });
  });

  test("needs-auth says nothing — the prompt box and /mcp own it", () => {
    expect(mcpNotice({ name: "linear", state: "needs-auth", url: "https://x/auth" })).toBeNull();
  });

  test("failure keeps a row saying what was lost", () => {
    const notice = mcpNotice({ name: "linear", state: "failed", error: "ECONNREFUSED" });
    expect(notice?.kind).toBe("row");
    expect(notice?.text).toContain("its tools are unavailable");
  });

  test("disconnected is not news — the operator chose it", () => {
    expect(mcpNotice({ name: "linear", state: "disconnected" })).toBeNull();
  });
});

describe("grantNotice", () => {
  test("names the grant and how to revoke it", () => {
    expect(grantNotice({ tool: "run_shell", pattern: "git status" })).toEqual({
      kind: "flash",
      text: "granted run_shell git status — /permissions to revoke",
    });
  });
});

describe("compactionNotice", () => {
  test("flashes before → after turn counts", () => {
    expect(compactionNotice({ turnsBefore: 42, turnsAfter: 8 })).toEqual({
      kind: "flash",
      text: "context compacted · 42 → 8 turns",
    });
  });
});

describe("payload validation", () => {
  test("hook events that are not hook.updated are dropped", () => {
    expect(lifecycleHookEvent({ type: "hooks.loaded", hooks: [] })).toBeNull();
    expect(lifecycleHookEvent(null)).toBeNull();
    expect(lifecycleHookEvent({ type: "hook.updated", hook: { id: 1 } })).toBeNull();
  });

  test("hook.updated survives with its exit status", () => {
    const parsed = lifecycleHookEvent({
      type: "hook.updated",
      hook: { ...hook, lastFiredAt: 5, lastExitStatus: { code: 1, signal: null, stderr: "x" } },
    });
    expect(parsed?.type).toBe("hook.updated");
  });

  test("mcp states parse per variant and reject junk", () => {
    expect(mcpServerState({ name: "a", state: "connected", tools: [] })?.state).toBe("connected");
    expect(mcpServerState({ name: "a", state: "disconnected" })?.state).toBe("disconnected");
    expect(mcpServerState({ name: "a", state: "needs-auth" })).toBeNull();
    expect(mcpServerState("nope")).toBeNull();
  });

  test("grant payloads unwrap the approval", () => {
    expect(grantApproval({ approval: { tool: "read", pattern: "**" } })).toEqual({
      tool: "read",
      pattern: "**",
    });
    expect(grantApproval({ approval: { tool: "read" } })).toBeNull();
  });

  test("progress payloads require both fields", () => {
    expect(subAgentProgress({ description: "map callers", toolName: "grep" })).toEqual({
      description: "map callers",
      toolName: "grep",
    });
    expect(subAgentProgress({ description: "map callers" })).toBeNull();
  });

  test("compaction payloads require both turn counts and reject junk", () => {
    expect(compactionFoldInfo({ turnsBefore: 42, turnsAfter: 8 })).toEqual({
      turnsBefore: 42,
      turnsAfter: 8,
    });
    expect(compactionFoldInfo({ turnsBefore: 42 })).toBeNull();
    expect(compactionFoldInfo(null)).toBeNull();
    expect(compactionFoldInfo("nope")).toBeNull();
  });
});
