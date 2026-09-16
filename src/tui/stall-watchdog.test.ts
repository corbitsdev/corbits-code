import { describe, expect, test } from "bun:test";

import {
  applyStallRecovery,
  isStalledForDisplay,
  repetitionRecoveryMessage,
  shouldAbortForStall,
  shouldNoticeStall,
  stallLevel,
  STALL_NOTICE_MS,
  STALL_RECOVERY_MESSAGE,
  STALL_TIMEOUT_MS,
} from "./stall-watchdog.js";

describe("shouldAbortForStall", () => {
  // Mid-stream hang: tokens already flowed, then everything went silent.
  const base = {
    status: "running" as const,
    awaitingResponse: false,
    lastActivityAt: 0,
    nowMs: STALL_TIMEOUT_MS,
    stallTimeoutMs: STALL_TIMEOUT_MS,
    isProcessing: true,
    streamingType: "text" as const,
    currentToolName: null,
    activeToolCalls: [],
    callIdByName: {},
  };

  test("aborts a mid-stream hang past the timeout", () => {
    expect(shouldAbortForStall(base)).toBe(true);
  });

  test("does not abort before the timeout", () => {
    expect(shouldAbortForStall({ ...base, nowMs: STALL_TIMEOUT_MS - 1 })).toBe(
      false,
    );
  });

  test("only running turns are watched", () => {
    expect(shouldAbortForStall({ ...base, status: "idle" })).toBe(false);
    expect(shouldAbortForStall({ ...base, status: "blocked" })).toBe(false);
    expect(shouldAbortForStall({ ...base, status: "done" })).toBe(false);
    expect(shouldAbortForStall({ ...base, status: "stopping" })).toBe(false);
  });

  test("a settled turn with nothing in flight is not a stall", () => {
    expect(
      shouldAbortForStall({
        ...base,
        streamingType: null,
        isProcessing: false,
      }),
    ).toBe(false);
  });

  test("mid-thinking silence fires, recent thinking tokens do not", () => {
    const thinking = { ...base, streamingType: "thinking" as const };
    expect(shouldAbortForStall(thinking)).toBe(true);
    expect(
      shouldAbortForStall({
        ...thinking,
        lastActivityAt: STALL_TIMEOUT_MS - 1,
      }),
    ).toBe(false);
  });

  test("mid-stream text hang aborts", () => {
    expect(shouldAbortForStall(base)).toBe(true);
  });

  test("long tool runs are not stalls", () => {
    expect(
      shouldAbortForStall({
        ...base,
        streamingType: "tool",
        currentToolName: "bash",
      }),
    ).toBe(false);
  });
});

// Awaiting the model's next response with no tokens yet — set right after
// submit, after the last tool call resolves, and after compact continuation
// re-entry (`turnStateOnSubmit`, `tool.done`, `beginSystemContinuation`).
// Cadence still ticks and the notice still arms at STALL_NOTICE_MS; past
// STALL_TIMEOUT_MS this shape auto-aborts so a continuation that never lands
// cannot freeze the turn.
describe("shouldAbortForStall — awaiting-response with a null stream eventually aborts", () => {
  const awaiting = {
    status: "running" as const,
    awaitingResponse: true,
    lastActivityAt: 0,
    nowMs: STALL_TIMEOUT_MS,
    stallTimeoutMs: STALL_TIMEOUT_MS,
    isProcessing: true,
    streamingType: null,
    currentToolName: null,
    activeToolCalls: [],
    callIdByName: {},
  };

  test("aborts a run awaiting a response once the stall budget elapses", () => {
    expect(
      shouldAbortForStall({ ...awaiting, nowMs: STALL_TIMEOUT_MS - 1 }),
    ).toBe(false);
    expect(shouldAbortForStall(awaiting)).toBe(true);
    expect(
      shouldAbortForStall({ ...awaiting, nowMs: STALL_TIMEOUT_MS * 10 }),
    ).toBe(true);
  });

  // Mirrors the tool.done handler: the last outstanding call just resolved,
  // awaitingResponse flips true and streamingType resets to null, then nothing
  // else arrives.
  test("post-tool-batch silence auto-aborts after the stall budget", () => {
    expect(shouldAbortForStall({ ...awaiting, activeToolCalls: [] })).toBe(
      true,
    );
  });

  // Same turn shape as compact continuation: beginSystemContinuation calls
  // turnStateOnSubmit, which is awaitingResponse + null streamingType.
  test("post-compact continuation silence auto-aborts after the stall budget", () => {
    expect(shouldAbortForStall(awaiting)).toBe(true);
  });

  test("a parallel fan-out with sibling tools still running is not a stall", () => {
    expect(
      shouldAbortForStall({ ...awaiting, activeToolCalls: ["call-2"] }),
    ).toBe(false);
  });

  // Two independent exemptions (a gate open on the operator, a sibling tool
  // call still outstanding) must both keep exempting when combined — neither
  // one's guard may accidentally require the other's condition to also hold.
  test("a gate open and a sibling tool call each exempt alone, and together", () => {
    const gateOnly = { ...awaiting, status: "blocked" as const };
    const toolCallOnly = { ...awaiting, activeToolCalls: ["call-2"] };
    const both = {
      ...awaiting,
      status: "blocked" as const,
      activeToolCalls: ["call-2"],
    };

    expect(shouldAbortForStall(gateOnly)).toBe(false);
    expect(shouldAbortForStall(toolCallOnly)).toBe(false);
    expect(shouldAbortForStall(both)).toBe(false);
  });
});

describe("shouldAbortForStall — execution-watchdog-exempt tools do not pin forever", () => {
  const collect = {
    status: "running" as const,
    awaitingResponse: false,
    lastActivityAt: 0,
    nowMs: STALL_TIMEOUT_MS,
    stallTimeoutMs: STALL_TIMEOUT_MS,
    isProcessing: true,
    streamingType: "tool" as const,
    currentToolName: "shell_collect",
    activeToolCalls: ["collect-1"],
    callIdByName: { shell_collect: "collect-1" },
  };

  test("in-flight collect auto-aborts after the stall budget", () => {
    expect(
      shouldAbortForStall({ ...collect, nowMs: STALL_TIMEOUT_MS - 1 }),
    ).toBe(false);
    expect(shouldAbortForStall(collect)).toBe(true);
  });

  test("wait_agents is bounded by the same stall budget", () => {
    expect(
      shouldAbortForStall({
        ...collect,
        currentToolName: "wait_agents",
        activeToolCalls: ["wait-1"],
        callIdByName: { wait_agents: "wait-1" },
      }),
    ).toBe(true);
  });

  // tool.done of a sibling bash clears currentToolName and streamingType
  // while shell_collect is still in activeToolCalls. Keying only the last
  // name would leave that poll unbounded forever.
  test("sibling tool.done while collect is in-flight still aborts at the stall budget", () => {
    const afterSiblingDone = {
      ...collect,
      currentToolName: null,
      streamingType: null,
      awaitingResponse: false,
      activeToolCalls: ["collect-1"],
      callIdByName: { shell_collect: "collect-1" },
    };
    expect(
      shouldAbortForStall({ ...afterSiblingDone, nowMs: STALL_TIMEOUT_MS - 1 }),
    ).toBe(false);
    expect(shouldAbortForStall(afterSiblingDone)).toBe(true);
  });

  test("a remaining ordinary tool after a sibling done is not a stall", () => {
    expect(
      shouldAbortForStall({
        ...collect,
        currentToolName: null,
        streamingType: null,
        awaitingResponse: false,
        activeToolCalls: ["bash-1"],
        callIdByName: { bash: "bash-1" },
      }),
    ).toBe(false);
  });

  // Two concurrent collects share one callIdByName slot: the second
  // registration overwrites the first, so when the mapping-owning sibling
  // resolves first and clears the slot, the leftover earlier collect is
  // invisible to the name-keyed check above. The per-id record keeps it
  // bounded (CL-8059).
  test("concurrent collects with the mapping owner done first still abort at the stall budget", () => {
    const leftover = {
      ...collect,
      currentToolName: null,
      streamingType: null,
      awaitingResponse: false,
      activeToolCalls: ["collect-1"],
      callIdByName: {},
      callNameById: { "collect-1": "shell_collect" },
    };
    expect(
      shouldAbortForStall({ ...leftover, nowMs: STALL_TIMEOUT_MS - 1 }),
    ).toBe(false);
    expect(shouldAbortForStall(leftover)).toBe(true);
  });

  test("a leftover ordinary tool tracked per-id is not a stall", () => {
    expect(
      shouldAbortForStall({
        ...collect,
        currentToolName: null,
        streamingType: null,
        awaitingResponse: false,
        activeToolCalls: ["bash-1"],
        callIdByName: {},
        callNameById: { "bash-1": "bash" },
      }),
    ).toBe(false);
  });
});

describe("applyStallRecovery", () => {
  test("aborts then notifies with the default message", () => {
    const calls: string[] = [];
    applyStallRecovery({
      abort: () => calls.push("abort"),
      notify: (m) => calls.push(m),
    });
    expect(calls).toEqual(["abort", STALL_RECOVERY_MESSAGE]);
  });

  test("aborts then notifies with a supplied message", () => {
    const calls: string[] = [];
    applyStallRecovery(
      { abort: () => calls.push("abort"), notify: (m) => calls.push(m) },
      "custom message",
    );
    expect(calls).toEqual(["abort", "custom message"]);
  });
});

describe("repetitionRecoveryMessage", () => {
  test("names degeneration and attributes the looped tokens", () => {
    const message = repetitionRecoveryMessage(42);
    expect(message).toContain("repeating itself");
    expect(message).toContain("42");
  });
});

describe("shouldNoticeStall", () => {
  const base = {
    status: "running" as const,
    awaitingResponse: true,
    lastActivityAt: 0,
    nowMs: STALL_NOTICE_MS,
    stallTimeoutMs: STALL_TIMEOUT_MS,
    stallNoticeMs: STALL_NOTICE_MS,
    isProcessing: true,
    streamingType: null,
    currentToolName: null,
    repeating: false,
    activeToolCalls: [],
    callIdByName: {},
  };

  test("a parallel fan-out with sibling tools still running does not notice", () => {
    expect(shouldNoticeStall({ ...base, activeToolCalls: ["call-2"] })).toBe(
      false,
    );
  });

  test("stays quiet while repeating, even if also silent by the clock", () => {
    expect(shouldNoticeStall({ ...base, repeating: true })).toBe(false);
  });

  test("speaks up long before the abort backstop", () => {
    expect(STALL_NOTICE_MS).toBeLessThan(STALL_TIMEOUT_MS);
    expect(shouldNoticeStall(base)).toBe(true);
    expect(shouldAbortForStall(base)).toBe(false);
  });

  test("stays quiet before the notice threshold", () => {
    expect(shouldNoticeStall({ ...base, nowMs: STALL_NOTICE_MS - 1 })).toBe(
      false,
    );
  });

  test("hands over to the abort once a mid-stream hang is aborted", () => {
    const midStream = {
      ...base,
      awaitingResponse: false,
      streamingType: "text" as const,
    };
    expect(shouldNoticeStall({ ...midStream, nowMs: STALL_TIMEOUT_MS })).toBe(
      false,
    );
  });

  test("an awaiting-response wait hands over to abort at the stall budget", () => {
    expect(shouldNoticeStall({ ...base, nowMs: STALL_TIMEOUT_MS })).toBe(false);
    expect(shouldAbortForStall({ ...base, nowMs: STALL_TIMEOUT_MS })).toBe(
      true,
    );
    expect(stallLevel({ ...base, nowMs: STALL_TIMEOUT_MS })).toBe("abort");
  });

  test("a long tool run is not stuck", () => {
    expect(
      shouldNoticeStall({
        ...base,
        awaitingResponse: false,
        streamingType: "tool",
        currentToolName: "bash",
      }),
    ).toBe(false);
  });

  test("in-flight collect notices, then aborts at the stall budget", () => {
    const collect = {
      ...base,
      awaitingResponse: false,
      streamingType: "tool" as const,
      currentToolName: "shell_collect",
      activeToolCalls: ["collect-1"],
    };
    expect(shouldNoticeStall(collect)).toBe(true);
    expect(shouldNoticeStall({ ...collect, nowMs: STALL_TIMEOUT_MS })).toBe(
      false,
    );
    expect(shouldAbortForStall({ ...collect, nowMs: STALL_TIMEOUT_MS })).toBe(
      true,
    );
  });
});

describe("the stall level the indicator reads", () => {
  const base = {
    status: "running" as const,
    awaitingResponse: true,
    lastActivityAt: 0,
    nowMs: STALL_NOTICE_MS,
    stallTimeoutMs: STALL_TIMEOUT_MS,
    stallNoticeMs: STALL_NOTICE_MS,
    isProcessing: true,
    streamingType: null,
    currentToolName: null,
    activeToolCalls: [],
    callIdByName: {},
    repeating: false,
  };

  test("quiet, notice and abort partition the same silence clock for a mid-stream hang", () => {
    const midStream = {
      ...base,
      awaitingResponse: false,
      streamingType: "text" as const,
    };
    expect(stallLevel({ ...midStream, nowMs: STALL_NOTICE_MS - 1 })).toBe(
      "quiet",
    );
    expect(stallLevel({ ...midStream, nowMs: STALL_NOTICE_MS })).toBe("notice");
    expect(stallLevel({ ...midStream, nowMs: STALL_TIMEOUT_MS })).toBe("abort");
  });

  test("an awaiting-response wait notices, then aborts at the stall budget", () => {
    expect(stallLevel({ ...base, nowMs: STALL_NOTICE_MS })).toBe("notice");
    expect(stallLevel({ ...base, nowMs: STALL_TIMEOUT_MS })).toBe("abort");
    expect(stallLevel({ ...base, nowMs: STALL_TIMEOUT_MS * 10 })).toBe("abort");
  });

  test("the indicator keeps reading stalled across the abort threshold", () => {
    // The notice hands over to the abort so the two never speak at once, but
    // the phase must not flip back to healthy at the exact moment the run is
    // most stuck — that was the whole complaint the indicator answers.
    const midStream = {
      ...base,
      awaitingResponse: false,
      streamingType: "text" as const,
    };
    expect(shouldNoticeStall({ ...midStream, nowMs: STALL_TIMEOUT_MS })).toBe(
      false,
    );
    expect(isStalledForDisplay({ ...midStream, nowMs: STALL_TIMEOUT_MS })).toBe(
      true,
    );
    expect(
      isStalledForDisplay({ ...midStream, nowMs: STALL_TIMEOUT_MS * 3 }),
    ).toBe(true);
  });

  test("a repeating run is not a stall on any surface", () => {
    const looping = { ...base, nowMs: STALL_TIMEOUT_MS, repeating: true };
    expect(stallLevel(looping)).toBe("quiet");
    expect(isStalledForDisplay(looping)).toBe(false);
  });
});
