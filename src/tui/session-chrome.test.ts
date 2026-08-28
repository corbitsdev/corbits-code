import { describe, expect, test } from "bun:test";

import {
  ACTIVITY_STATES,
  classifyAgentSendFailure,
  classifySendFailureMessage,
  resolveRampPhase,
  resolveTurnLabel,
  sendFailureText,
  shouldSettleUiAfterSendFailure,
} from "./session-chrome.js";

// The load-bearing guarantee: whatever tool identifier, MCP server name, or
// plugin name the runtime hands us, the rendered ticker string must land in
// the small closed set of human activity states — never the raw identifier.
// A previously-unmapped tool (or one this test doesn't enumerate) must still
// fall back into the set rather than leaking through verbatim.
describe("resolveTurnLabel closed-set guarantee", () => {
  const leakingIdentifiers = [
    "run_shell",
    "grep",
    "read_file",
    "write_file",
    "edit_file",
    "search_files",
    "list_dir",
    "web_search",
    "web_fetch",
    "manage_tasks",
    "task",
    "submit_output",
    "ask_operator",
    "mcp__glitchtip__authenticate",
    "mcp__railway__deploy",
    "some_未knownしplugin_tool",
    "a-plugin-defined-tool-name",
    "totally_unmapped_future_tool",
  ];

  for (const currentToolName of leakingIdentifiers) {
    test(`"${currentToolName}" resolves to a member of the closed set`, () => {
      const label = resolveTurnLabel(
        {
          isProcessing: true,
          status: "running",
          currentToolName,
          streamingType: "tool",
        },
        false,
        null,
      );
      expect(label).not.toBe(currentToolName);
      expect(ACTIVITY_STATES).toContain(label!);
    });
  }

  test("a silent turn still reads as ordinary work to the operator", () => {
    const label = resolveTurnLabel(
      {
        isProcessing: true,
        status: "running",
        currentToolName: "run_shell",
        streamingType: "tool",
      },
      true,
      null,
    );
    // Recovery is silent — never paint "stalled" in the ticker.
    expect(label).toBe("building");
    expect(ACTIVITY_STATES).toContain(label!);
  });

  test("waiting on the operator is distinguishable from working", () => {
    const label = resolveTurnLabel(
      {
        isProcessing: true,
        status: "blocked",
        currentToolName: "run_shell",
        streamingType: "tool",
      },
      false,
      null,
    );
    expect(label).toBe("waiting");
    expect(label).not.toBe("working");
    expect(ACTIVITY_STATES).toContain(label!);
  });
});

describe("resolveTurnLabel", () => {
  test("idle processing off yields no label", () => {
    expect(
      resolveTurnLabel(
        {
          isProcessing: false,
          status: "idle",
          currentToolName: null,
          streamingType: null,
        },
        false,
        null,
      ),
    ).toBeUndefined();
  });

  test("blocked gate shows a waiting-on-operator state", () => {
    expect(
      resolveTurnLabel(
        {
          isProcessing: true,
          status: "blocked",
          currentToolName: "run_shell",
          streamingType: "tool",
        },
        false,
        null,
      ),
    ).toBe("waiting");
  });

  test("stopping beats tool phase", () => {
    expect(
      resolveTurnLabel(
        {
          isProcessing: true,
          status: "stopping",
          currentToolName: "grep",
          streamingType: "tool",
        },
        false,
        null,
      ),
    ).toBe("stopping");
  });

  test("tool phase maps to its semantic activity, never the raw name", () => {
    expect(
      resolveTurnLabel(
        {
          isProcessing: true,
          status: "running",
          currentToolName: "grep",
          streamingType: "tool",
        },
        false,
        null,
      ),
    ).toBe("researching");
  });

  test("thinking and text phases", () => {
    const base = {
      isProcessing: true,
      status: "running" as const,
      currentToolName: null,
    };
    expect(resolveTurnLabel({ ...base, streamingType: "thinking" }, false, null)).toBe("thinking");
    expect(resolveTurnLabel({ ...base, streamingType: "text" }, false, null)).toBe("working");
    expect(resolveTurnLabel({ ...base, streamingType: null }, false, null)).toBe("working");
  });
});

describe("resolveRampPhase", () => {
  const base = {
    isProcessing: true,
    currentToolName: null,
    streamingType: null,
  };

  test("blocked gate freezes the ramp", () => {
    expect(resolveRampPhase({ ...base, status: "blocked" }, false, null)).toBe("blocked");
  });

  test("done fills the ramp", () => {
    expect(resolveRampPhase({ ...base, status: "done" }, false, null)).toBe("done");
  });

  test("everything else is working", () => {
    expect(resolveRampPhase({ ...base, status: "running" }, false, null)).toBe("working");
    expect(resolveRampPhase({ ...base, status: "stopping" }, false, null)).toBe("working");
  });

  test("a silent running turn still paints working, not stalled", () => {
    expect(resolveRampPhase({ ...base, status: "running" }, true, null)).toBe("working");
  });

  test("a blocked gate beats stalled — waiting on you outranks silence", () => {
    expect(resolveRampPhase({ ...base, status: "blocked" }, true, null)).toBe("blocked");
  });
});

describe("classifyAgentSendFailure", () => {
  const codex = (e: unknown) => e === "codex";
  const xai = (e: unknown) => e === "xai";

  test("abort is ignored", () => {
    expect(classifyAgentSendFailure(new Error("x"), true, codex, xai)).toEqual({
      kind: "abort",
      authProvider: null,
    });
    expect(shouldSettleUiAfterSendFailure("abort")).toBe(false);
  });

  test("generic error settles ui", () => {
    expect(classifyAgentSendFailure(new Error("boom"), false, codex, xai)).toEqual({
      kind: "error",
      authProvider: null,
    });
    expect(shouldSettleUiAfterSendFailure("error")).toBe(true);
  });

  test("auth failures settle ui for idle footer", () => {
    expect(classifyAgentSendFailure("codex", false, codex, xai)).toEqual({
      kind: "auth",
      authProvider: "codex",
    });
    expect(classifyAgentSendFailure("xai", false, codex, xai)).toEqual({
      kind: "auth",
      authProvider: "xai",
    });
    expect(shouldSettleUiAfterSendFailure("auth")).toBe(true);
  });

  test("anthropic and generic credential rejections classify as auth", () => {
    expect(
      classifyAgentSendFailure(new Error("anthropic: invalid x-api-key"), false, codex, xai),
    ).toEqual({ kind: "auth", authProvider: "anthropic" });
    expect(
      classifyAgentSendFailure(
        new Error("Request failed with status 401 Unauthorized"),
        false,
        codex,
        xai,
      ),
    ).toEqual({ kind: "auth", authProvider: "other" });
  });
});

describe("sendFailureText", () => {
  test("an expired subscription sign-in says what to press", () => {
    const codex = sendFailureText('Codex profile "default" is not authorized. Log in again.');
    expect(
      classifySendFailureMessage('Codex profile "default" is not authorized. Log in again.'),
    ).toEqual({ kind: "auth", authProvider: "codex" });
    expect(codex).toContain("sign-in expired");
    expect(codex).toContain("/model");

    const xai = sendFailureText('xAI profile "default" could not be refreshed (401).');
    expect(xai).toContain("/model");
    expect(xai).not.toContain("401");

    const anthropic = sendFailureText("authentication_error: invalid x-api-key");
    expect(anthropic).toContain("anthropic");
    expect(anthropic).toContain("/model");
  });

  test("an unclassified failure keeps its raw message", () => {
    expect(sendFailureText("connection reset by peer")).toBe("connection reset by peer");
    expect(classifySendFailureMessage("connection reset by peer")).toEqual({
      kind: "error",
      authProvider: null,
    });
  });

  test("a classified credential_failure line is not rewritten as generic other", () => {
    expect(sendFailureText("Authentication failed — log in again.")).toBe(
      "Authentication failed — log in again.",
    );
  });
});

describe("fleet state in the top-level indicator", () => {
  const parentAwaitingChildren = {
    isProcessing: true,
    status: "running" as const,
    currentToolName: "task",
    streamingType: "tool" as const,
  };
  const fleet = (running: number, stalled: number) => ({
    running,
    working: running - stalled,
    inTool: 0,
    stalled,
  });

  test("a healthy fleet reads as working, not the parent's own tool", () => {
    const label = resolveTurnLabel(parentAwaitingChildren, false, fleet(6, 0));
    expect(label).toBe("working");
    expect(ACTIVITY_STATES).toContain(label!);
  });

  test("a quiet fleet still reads working at the top level", () => {
    expect(resolveTurnLabel(parentAwaitingChildren, false, fleet(6, 1))).toBe("working");
    expect(resolveRampPhase(parentAwaitingChildren, false, fleet(6, 1))).toBe("working");
  });

  // The parent is idle by design while children run, so its own stall clock
  // firing says nothing about whether the session is progressing.
  test("live lanes outrank the parent's own stall clock", () => {
    expect(resolveTurnLabel(parentAwaitingChildren, true, fleet(6, 0))).toBe("working");
    expect(resolveRampPhase(parentAwaitingChildren, true, fleet(6, 0))).toBe("working");
  });

  test("with no sub-agents running the single-agent case is unchanged", () => {
    const none = fleet(0, 0);
    expect(resolveTurnLabel(parentAwaitingChildren, false, none)).toBe(
      resolveTurnLabel(parentAwaitingChildren, false, null),
    );
    expect(resolveTurnLabel(parentAwaitingChildren, true, none)).toBe("planning");
    expect(resolveRampPhase(parentAwaitingChildren, true, none)).toBe("working");
  });

  test("a blocked gate still outranks the fleet", () => {
    expect(
      resolveTurnLabel({ ...parentAwaitingChildren, status: "blocked" }, false, fleet(6, 3)),
    ).toBe("waiting");
    expect(
      resolveTurnLabel({ ...parentAwaitingChildren, status: "stopping" }, false, fleet(6, 3)),
    ).toBe("stopping");
  });
});
