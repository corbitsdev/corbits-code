/**
 * Pure notice formatting + emitter payload validation.
 */
import { describe, expect, test } from "bun:test";

import { defined } from "../../tests/helpers/defined.js";
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
  workflowNotice,
  workflowPayloadInfo,
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
        lastExitStatus: {
          code: 2,
          signal: null,
          stderr: "prettier not found\n",
        },
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
    expect(
      mcpNotice({ name: "linear", state: "connected", tools: ["a", "b"] }),
    ).toEqual({
      kind: "flash",
      text: "mcp linear connected · 2 tools",
    });
  });

  test("needs-auth says nothing — the prompt box and /mcp own it", () => {
    expect(
      mcpNotice({ name: "linear", state: "needs-auth", url: "https://x/auth" }),
    ).toBeNull();
  });

  test("failure keeps a row saying what was lost", () => {
    const notice = mcpNotice({
      name: "linear",
      state: "failed",
      error: "ECONNREFUSED",
    });
    expect(notice?.kind).toBe("row");
    expect(notice?.text).toContain("its tools are unavailable");
  });

  test("an unfinished browser authorization stays on the marker, not a row", () => {
    expect(
      mcpNotice({
        name: "linear",
        state: "failed",
        error: "timed out waiting for the browser",
        authPending: true,
      }),
    ).toBeNull();
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
    expect(
      lifecycleHookEvent({ type: "hook.updated", hook: { id: 1 } }),
    ).toBeNull();
  });

  test("hook.updated survives with its exit status", () => {
    const parsed = lifecycleHookEvent({
      type: "hook.updated",
      hook: {
        ...hook,
        lastFiredAt: 5,
        lastExitStatus: { code: 1, signal: null, stderr: "x" },
      },
    });
    expect(parsed?.type).toBe("hook.updated");
  });

  test("mcp states parse per variant and reject junk", () => {
    expect(
      mcpServerState({ name: "a", state: "connected", tools: [] })?.state,
    ).toBe("connected");
    expect(mcpServerState({ name: "a", state: "disconnected" })?.state).toBe(
      "disconnected",
    );
    expect(mcpServerState({ name: "a", state: "needs-auth" })).toBeNull();
    expect(
      mcpServerState({
        name: "a",
        state: "failed",
        error: "x",
        authPending: true,
      }),
    ).toMatchObject({ state: "failed", authPending: true });
    expect(mcpServerState("nope")).toBeNull();
  });

  test("grant payloads unwrap the approval", () => {
    expect(
      grantApproval({ approval: { tool: "read", pattern: "**" } }),
    ).toEqual({
      tool: "read",
      pattern: "**",
    });
    expect(grantApproval({ approval: { tool: "read" } })).toBeNull();
  });

  test("progress payloads require both fields", () => {
    expect(
      subAgentProgress({ description: "map callers", toolName: "grep" }),
    ).toEqual({
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

  test("workflow payloads require current + history and reject junk", () => {
    expect(
      workflowPayloadInfo({
        current: {
          active: true,
          name: "ship",
          stepIndex: 0,
          total: 2,
          label: "build",
        },
        history: [],
      }),
    ).toEqual({
      current: {
        active: true,
        name: "ship",
        stepIndex: 0,
        total: 2,
        label: "build",
      },
      history: [],
    });
    expect(workflowPayloadInfo({ current: { active: true } })).toBeNull();
    expect(workflowPayloadInfo(null)).toBeNull();
    expect(workflowPayloadInfo("nope")).toBeNull();
  });

  test("live inactive payload with name: undefined and extra status keys parses", () => {
    const parsed = workflowPayloadInfo({
      current: {
        active: false,
        name: undefined,
        stepIndex: 0,
        total: 0,
        label: "",
        steps: [{ id: "a" }],
        capabilities: ["x"],
      },
      history: [{ name: "ship", extra: true }],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.current.active).toBe(false);
    expect(parsed?.current.name).toBeUndefined();
    expect(parsed?.history.at(-1)?.name).toBe("ship");
  });
});

describe("workflowNotice", () => {
  test("active named step flashes index+1 and label", () => {
    expect(
      workflowNotice({
        current: {
          active: true,
          name: "ship",
          stepIndex: 0,
          total: 2,
          label: "build",
        },
        history: [],
      }),
    ).toEqual({
      kind: "flash",
      text: "workflow ship · step 1/2: build",
    });
  });

  test("inactive with last history name flashes complete only when wasActive", () => {
    const payload = {
      current: {
        active: false,
        name: undefined as string | undefined,
        stepIndex: 1,
        total: 2,
        label: "done",
      },
      history: [{ name: "ship" }],
    };
    expect(workflowNotice(payload, { wasActive: true })).toEqual({
      kind: "flash",
      text: "workflow ship complete",
    });
    expect(workflowNotice(payload, { wasActive: false })).toBeNull();
    expect(workflowNotice(payload)).toBeNull();
  });

  test("idle snapshots say nothing", () => {
    expect(
      workflowNotice({
        current: { active: false, stepIndex: 0, total: 0, label: "" },
        history: [],
      }),
    ).toBeNull();
    expect(
      workflowNotice({
        current: { active: true, stepIndex: 0, total: 1, label: "x" },
        history: [],
      }),
    ).toBeNull();
  });

  test("active live payload with extra keys still flashes the step", () => {
    const parsed = workflowPayloadInfo({
      current: {
        active: true,
        name: "ship",
        stepIndex: 0,
        total: 2,
        label: "build",
        steps: [],
        capabilities: [],
      },
      history: [],
    });
    expect(parsed).not.toBeNull();
    expect(workflowNotice(defined(parsed))).toEqual({
      kind: "flash",
      text: "workflow ship · step 1/2: build",
    });
  });
});
