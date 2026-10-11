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
import { initialTurnState, turnStateFromEvent } from "./turn-state.js";

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
    callNameById: {},
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

  test("long tool runs are not stalls", () => {
    expect(
      shouldAbortForStall({
        ...base,
        streamingType: "tool",
        currentToolName: "bash",
      }),
    ).toBe(false);
  });

  test.each(["wait_agents", "wait"] as const)(
    "in-flight %s is stall-bounded under any wire name",
    (currentToolName) => {
      // streamingType "tool" isolates the stall-bounded branch: an ordinary
      // tool run with this shape is not a stall (see above).
      expect(
        shouldAbortForStall({
          ...base,
          streamingType: "tool",
          currentToolName,
        }),
      ).toBe(true);
    },
  );
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
    callNameById: {},
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
    currentToolName: "wait_agents",
    activeToolCalls: ["collect-1"],
    callIdByName: { wait_agents: "collect-1" },
    callNameById: { "collect-1": "wait_agents" },
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
        callNameById: { "wait-1": "wait_agents" },
      }),
    ).toBe(true);
  });

  // ask_director is bounded, not exempt (CL-10206): the primary never mounts
  // it, so the name is a guard, and a stray mount must notice, then abort,
  // like wait_agents. Both shapes the turn state can hold are pinned: the
  // announced call, and a leftover tracked only per-id after a sibling
  // cleared currentToolName and the shared callIdByName slot.
  test.each([
    {
      representation: "direct",
      currentToolName: "ask_director",
      activeToolCalls: ["ask-1"],
      callIdByName: { ask_director: "ask-1" },
      callNameById: { "ask-1": "ask_director" },
    },
    {
      representation: "mapping-only",
      currentToolName: null,
      activeToolCalls: ["ask-1"],
      callIdByName: {},
      callNameById: { "ask-1": "ask_director" },
    },
  ])(
    "in-flight ask_director ($representation) is quiet, then notices, then aborts, and every surface agrees",
    (ask) => {
      const inFlightAsk = {
        ...collect,
        ...ask,
        streamingType: "tool" as const,
        stallNoticeMs: STALL_NOTICE_MS,
        repeating: false,
      };
      const points = [
        { nowMs: STALL_NOTICE_MS - 1, level: "quiet" },
        { nowMs: STALL_NOTICE_MS, level: "notice" },
        { nowMs: STALL_TIMEOUT_MS - 1, level: "notice" },
        { nowMs: STALL_TIMEOUT_MS, level: "abort" },
      ] as const;

      for (const { nowMs, level } of points) {
        const args = { ...inFlightAsk, nowMs };
        expect(stallLevel(args)).toBe(level);
        expect(shouldAbortForStall(args)).toBe(level === "abort");
        expect(shouldNoticeStall(args)).toBe(level === "notice");
        expect(isStalledForDisplay(args)).toBe(level !== "quiet");
      }
    },
  );

  // tool.done of a sibling bash clears currentToolName and streamingType
  // while wait_agents is still in activeToolCalls. Keying only the last
  // name would leave that poll unbounded forever.
  test("sibling tool.done while collect is in-flight still aborts at the stall budget", () => {
    const afterSiblingDone = {
      ...collect,
      currentToolName: null,
      streamingType: null,
      awaitingResponse: false,
      activeToolCalls: ["collect-1"],
      callIdByName: { wait_agents: "collect-1" },
      callNameById: { "collect-1": "wait_agents" },
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
        callNameById: { "bash-1": "bash" },
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
      callNameById: { "collect-1": "wait_agents" },
    };
    expect(
      shouldAbortForStall({ ...leftover, nowMs: STALL_TIMEOUT_MS - 1 }),
    ).toBe(false);
    expect(shouldAbortForStall(leftover)).toBe(true);
  });

  test("folded leftover collect after mapping owner done still aborts at the stall budget", () => {
    const leftover = [
      { type: "inference.start" },
      {
        type: "tool.start",
        data: { call: { id: "collect-1", name: "wait_agents" } },
      },
      {
        type: "tool.start",
        data: { call: { id: "collect-2", name: "wait_agents" } },
      },
      {
        type: "tool.done",
        data: { result: { callId: "collect-2" } },
      },
    ].reduce(
      (state, event, i) => turnStateFromEvent(state, event, i + 1),
      initialTurnState(0),
    );
    expect(leftover.callIdByName).toEqual({});
    expect(
      shouldAbortForStall({
        ...leftover,
        nowMs: leftover.lastActivityAt + STALL_TIMEOUT_MS - 1,
        stallTimeoutMs: STALL_TIMEOUT_MS,
      }),
    ).toBe(false);
    expect(
      shouldAbortForStall({
        ...leftover,
        nowMs: leftover.lastActivityAt + STALL_TIMEOUT_MS,
        stallTimeoutMs: STALL_TIMEOUT_MS,
      }),
    ).toBe(true);
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
  test("aborts first, then notifies with the given or default message", () => {
    const calls: string[] = [];
    const abort = () => calls.push("abort");
    applyStallRecovery({ abort, notify: (m) => calls.push(m) });
    applyStallRecovery(
      { abort, notify: (m) => calls.push(m) },
      "custom message",
    );
    expect(calls).toEqual([
      "abort",
      STALL_RECOVERY_MESSAGE,
      "abort",
      "custom message",
    ]);
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
    callNameById: {},
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
      currentToolName: "wait_agents",
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
    callNameById: {},
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
