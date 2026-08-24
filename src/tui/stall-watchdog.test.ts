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
  // Mid-stream hang: tokens already flowed, then everything went silent —
  // the one shape auto-abort is willing to act on. The generic guards
  // (status, threshold, exemptions) are exercised against this base.
  const base = {
    status: "running" as const,
    awaitingResponse: false,
    lastActivityAt: 0,
    nowMs: STALL_TIMEOUT_MS,
    stallTimeoutMs: STALL_TIMEOUT_MS,
    isProcessing: true,
    streamingType: "text" as const,
    activeToolCalls: [],
  };

  test("aborts a mid-stream hang past the timeout", () => {
    expect(shouldAbortForStall(base)).toBe(true);
  });

  test("does not abort before the timeout", () => {
    expect(shouldAbortForStall({ ...base, nowMs: STALL_TIMEOUT_MS - 1 })).toBe(false);
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
    expect(shouldAbortForStall({ ...thinking, lastActivityAt: STALL_TIMEOUT_MS - 1 })).toBe(false);
  });

  test("mid-stream text hang aborts", () => {
    expect(shouldAbortForStall(base)).toBe(true);
  });

  test("long tool runs are not stalls", () => {
    expect(shouldAbortForStall({ ...base, streamingType: "tool" })).toBe(false);
  });
});

// The other shape silence can take: awaiting the model's next response, with
// no tokens yet — set right after submit and again the instant the last
// outstanding tool call resolves (`turnStateOnSubmit`, the `tool.done`
// handler). A slow model produces exactly this state for as long as it takes
// to reply, so it is never auto-aborted, however long the silence — only the
// notice may surface. This is the regression coverage for CL-5640.
describe("shouldAbortForStall — awaiting the model's next token is never auto-aborted", () => {
  const awaiting = {
    status: "running" as const,
    awaitingResponse: true,
    lastActivityAt: 0,
    nowMs: STALL_TIMEOUT_MS,
    stallTimeoutMs: STALL_TIMEOUT_MS,
    isProcessing: true,
    streamingType: null,
    activeToolCalls: [],
  };

  test("does not abort a run merely awaiting a response, however long", () => {
    expect(shouldAbortForStall(awaiting)).toBe(false);
    expect(shouldAbortForStall({ ...awaiting, nowMs: STALL_TIMEOUT_MS * 10 })).toBe(false);
  });

  // Mirrors the tool.done handler: the last outstanding call just resolved,
  // awaitingResponse flips true and streamingType resets to null, then the
  // model itself takes a long-but-healthy while to start its next reply.
  test("healthy post-tool-batch wait never auto-aborts", () => {
    expect(shouldAbortForStall({ ...awaiting, activeToolCalls: [] })).toBe(false);
  });

  test("a parallel fan-out with sibling tools still running is not a stall", () => {
    expect(shouldAbortForStall({ ...awaiting, activeToolCalls: ["call-2"] })).toBe(false);
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
    repeating: false,
    activeToolCalls: [],
  };

  test("a parallel fan-out with sibling tools still running does not notice", () => {
    expect(shouldNoticeStall({ ...base, activeToolCalls: ["call-2"] })).toBe(false);
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
    expect(shouldNoticeStall({ ...base, nowMs: STALL_NOTICE_MS - 1 })).toBe(false);
  });

  test("hands over to the abort once a mid-stream hang is aborted", () => {
    const midStream = {
      ...base,
      awaitingResponse: false,
      streamingType: "text" as const,
    };
    expect(shouldNoticeStall({ ...midStream, nowMs: STALL_TIMEOUT_MS })).toBe(false);
  });

  test("a healthy wait for the model's next token keeps noticing rather than handing over to an abort", () => {
    // Unlike the mid-stream case above, this shape never reaches "abort" —
    // see the shouldAbortForStall describe block above — so the notice keeps
    // surfacing indefinitely instead of going silent once the old timeout
    // would have fired.
    expect(shouldNoticeStall({ ...base, nowMs: STALL_TIMEOUT_MS })).toBe(true);
    expect(shouldNoticeStall({ ...base, nowMs: STALL_TIMEOUT_MS * 10 })).toBe(true);
  });

  test("a long tool run is not stuck", () => {
    expect(
      shouldNoticeStall({
        ...base,
        awaitingResponse: false,
        streamingType: "tool",
      }),
    ).toBe(false);
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
    activeToolCalls: [],
    repeating: false,
  };

  test("quiet, notice and abort partition the same silence clock for a mid-stream hang", () => {
    const midStream = { ...base, awaitingResponse: false, streamingType: "text" as const };
    expect(stallLevel({ ...midStream, nowMs: STALL_NOTICE_MS - 1 })).toBe("quiet");
    expect(stallLevel({ ...midStream, nowMs: STALL_NOTICE_MS })).toBe("notice");
    expect(stallLevel({ ...midStream, nowMs: STALL_TIMEOUT_MS })).toBe("abort");
  });

  // Awaiting the model's next token (right after submit, or right after a
  // tool batch resolves) never escalates to "abort" — see
  // shouldAbortForStall's dedicated describe block — so this shape stays at
  // "notice" indefinitely instead of handing over.
  test("a healthy wait for the model's next token stays at notice, never abort", () => {
    expect(stallLevel({ ...base, nowMs: STALL_NOTICE_MS })).toBe("notice");
    expect(stallLevel({ ...base, nowMs: STALL_TIMEOUT_MS })).toBe("notice");
    expect(stallLevel({ ...base, nowMs: STALL_TIMEOUT_MS * 10 })).toBe("notice");
  });

  test("the indicator keeps reading stalled across the abort threshold", () => {
    // The notice hands over to the abort so the two never speak at once, but
    // the phase must not flip back to healthy at the exact moment the run is
    // most stuck — that was the whole complaint the indicator answers.
    const midStream = { ...base, awaitingResponse: false, streamingType: "text" as const };
    expect(shouldNoticeStall({ ...midStream, nowMs: STALL_TIMEOUT_MS })).toBe(false);
    expect(isStalledForDisplay({ ...midStream, nowMs: STALL_TIMEOUT_MS })).toBe(true);
    expect(isStalledForDisplay({ ...midStream, nowMs: STALL_TIMEOUT_MS * 3 })).toBe(true);
  });

  test("a repeating run is not a stall on any surface", () => {
    const looping = { ...base, nowMs: STALL_TIMEOUT_MS, repeating: true };
    expect(stallLevel(looping)).toBe("quiet");
    expect(isStalledForDisplay(looping)).toBe(false);
  });
});
