import { describe, expect, test } from "bun:test";
import type {
  InboundMessage,
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
  ReactorState,
} from "@intx/types/runtime";
import { createChatDirector } from "./director.js";
import { forcedStopReport } from "../subagent/stop-policy.js";
import { OPERATOR_ORIGINATED_FLAG } from "./message-provenance.js";
import { buildCompactionContinuationMessage as tuiCompactionContinuation } from "../tui/runner.js";
import { buildCompactionContinuationMessage as execCompactionContinuation } from "../exec/runner.js";
import { buildCompactionContinuationMessage as subagentCompactionContinuation } from "../subagent/run.js";

const mockState: ReactorState = { turns: [] } as unknown as ReactorState;

function makeCapabilities(): ReactorCapabilities {
  return {
    infer: (options) =>
      ({ type: "infer", ...(options !== undefined ? { options } : {}) }) as ReactorAction,
    executeTools: (calls, parallel, addToHistory) =>
      ({ type: "execute_tools", calls, parallel, addToHistory }) as ReactorAction,
    suspend: (gate) => ({ type: "suspend", gate }) as ReactorAction,
    fork: (mode, forkId) => ({ type: "fork", mode, forkId }) as ReactorAction,
    emit: (eventType, data) => ({ type: "emit", eventType, data }) as ReactorAction,
    reply: (content) => ({ type: "reply", content }) as ReactorAction,
    checkpoint: (message = "") => ({ type: "checkpoint", message }) as ReactorAction,
    compact: (compactor, reason) => ({ type: "compact", compactor, reason }) as ReactorAction,
    wait: () => ({ type: "wait" }) as ReactorAction,
    done: () => ({ type: "done" }) as ReactorAction,
  };
}

// Varied arguments per call so the fingerprint changes turn to turn — the
// shape of genuine, varied tool-only orchestration (Linear lookups, reading
// different files, ...), as opposed to repeatedToolOnlyTurn below.
function toolOnlyTurn(id: string): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      model: "test",
      timestamp: 0,
      content: [{ type: "tool_call", id, name: "read_file", arguments: { path: `${id}.ts` } }],
    },
    usage: { input: 0, output: 0 },
    source: "test",
  } as unknown as ReactorInboundEvent;
}

// Identical tool name + arguments on every call regardless of id — the shape
// of genuine no-progress thrash (fingerprintToolCalls ignores call id).
function repeatedToolOnlyTurn(id: string): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      model: "test",
      timestamp: 0,
      content: [{ type: "tool_call", id, name: "read_file", arguments: { path: "a.ts" } }],
    },
    usage: { input: 0, output: 0 },
    source: "test",
  } as unknown as ReactorInboundEvent;
}

function textAndToolTurn(id: string, text: string): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      model: "test",
      timestamp: 0,
      content: [
        { type: "text", text },
        { type: "tool_call", id, name: "read_file", arguments: { path: "a.ts" } },
      ],
    },
    usage: { input: 0, output: 0 },
    source: "test",
  } as unknown as ReactorInboundEvent;
}

function toolDoneEvent(callId: string): ReactorInboundEvent {
  return {
    type: "tool.done",
    result: { callId, content: "ok" },
  } as unknown as ReactorInboundEvent;
}

// A parent turn dispatching a leaf `task` call — varied arguments per id so
// the fingerprint changes turn to turn (mirrors toolOnlyTurn's shape, but
// with the tool name pendingTaskCallIds actually tracks).
function taskTurn(id: string): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      model: "test",
      timestamp: 0,
      content: [{ type: "tool_call", id, name: "task", arguments: { prompt: `do ${id}` } }],
    },
    usage: { input: 0, output: 0 },
    source: "test",
  } as unknown as ReactorInboundEvent;
}

// A task tool.done result. Defaults to a plain successful completion (no
// tool error, no salvage-classifiable envelope in the body) — CL-5893's
// "successful leaf tool.done" progress signal.
function taskDoneEvent(
  callId: string,
  options: { isError?: boolean; content?: string } = {},
): ReactorInboundEvent {
  return {
    type: "tool.done",
    result: { callId, isError: options.isError ?? false, content: options.content ?? "ok" },
  } as unknown as ReactorInboundEvent;
}

// A genuine operator submit — carries OPERATOR_ORIGINATED_FLAG, matching what
// userInboundMessage() builds at the real TUI/exec prompt-submit sites.
function messageReceived(content = "hello"): ReactorInboundEvent {
  return {
    type: "message.received",
    message: { content, flags: [OPERATOR_ORIGINATED_FLAG] },
  } as unknown as ReactorInboundEvent;
}

// A message.received event carrying a system-originated message — no
// OPERATOR_ORIGINATED_FLAG — as director.ts would actually receive it when
// the runner delivers one. Wraps the real message builders so this test
// proves the backstop against actual production payloads, not a shape the
// test merely believes matches them.
function systemMessageReceived(message: InboundMessage): ReactorInboundEvent {
  return { type: "message.received", message } as unknown as ReactorInboundEvent;
}

function actionsArray(result: ReactorAction | ReactorAction[]): ReactorAction[] {
  return Array.isArray(result) ? result : [result];
}

function ephemeralText(action: ReactorAction | undefined): string | undefined {
  if (action === undefined || action.type !== "infer") return undefined;
  const opts = action.options as
    { ephemeralTurns?: { content: { text?: string }[] }[] } | undefined;
  return opts?.ephemeralTurns?.[0]?.content?.[0]?.text;
}

// Drive N consecutive tool-only turns (tool_call -> tool.done -> tool_call -> ...).
async function runToolOnlyStreak(
  director: ReturnType<typeof createChatDirector>,
  capabilities: ReactorCapabilities,
  count: number,
  makeTurn: (id: string) => ReactorInboundEvent = toolOnlyTurn,
): Promise<ReactorAction[]> {
  let last: ReactorAction[] = [];
  for (let i = 0; i < count; i++) {
    const id = `tc-${i}`;
    await director.decide(makeTurn(id), mockState, capabilities);
    last = actionsArray(await director.decide(toolDoneEvent(id), mockState, capabilities));
  }
  return last;
}

describe("ChatDirector tool-only loop protection", () => {
  const providerlessPolicy = { providerName: "test-provider" };

  test("nudges once at the family threshold, after pending tools execute", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    // Default family nudges at 25 consecutive tool-only turns.
    const actions = await runToolOnlyStreak(director, capabilities, 25);
    const infer = actions.find((a) => a.type === "infer");
    expect(infer).toBeDefined();
    expect(ephemeralText(infer)).toBeDefined();
  });

  test("the nudge is one-shot — it does not repeat on the next tool-only turn", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    await runToolOnlyStreak(director, capabilities, 25);
    const nextTurn = actionsArray(await runToolOnlyStreak(director, capabilities, 1));
    const infer = nextTurn.find((a) => a.type === "infer");
    expect(infer).toBeDefined();
    expect(ephemeralText(infer)).toBeUndefined();
  });

  // Required by CL-5611: a long productive tool-only streak (varied
  // fingerprints every turn) must run straight through both the nudge and
  // well past any prior hard-pause threshold without ever pausing.
  test("a long productive tool-only streak continues without pausing", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    const actions = await runToolOnlyStreak(director, capabilities, 50);
    expect(actions.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(
      false,
    );
    expect(actions.some((a) => a.type === "infer")).toBe(true);
  });

  // Required by CL-5611 (reworked): genuine no-progress (identical tool
  // fingerprint repeating) must still be caught and stop the session. The
  // period-1 (identical-consecutive) repeat floor is 5, not 4 — see
  // "does not pause after 4 identical polls" below for why 4 must not fire.
  test("pauses when the same tool call repeats without progress", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    const actions = await runToolOnlyStreak(director, capabilities, 5, repeatedToolOnlyTurn);
    expect(actions.some((a) => a.type === "infer")).toBe(false);
    const reply = actions.find((a) => a.type === "reply");
    expect(reply).toBeDefined();
    if (reply === undefined || reply.type !== "reply") throw new Error("expected reply action");
    expect(reply.content).toContain("Auto-paused");
    expect(reply.content).toContain("Send a message to resume");
  });

  // Required by the CL-5611 rework: a short run of identical calls is
  // legitimate (rerunning a flaky test, polling a build) — critique found the
  // old 4-repeat hard pause false-positived on exactly this. Four identical
  // polls followed by varied work must run straight through with no pause.
  test("does not pause after 4 identical polls followed by varied work", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    await runToolOnlyStreak(director, capabilities, 4, repeatedToolOnlyTurn);
    const actions = await runToolOnlyStreak(director, capabilities, 3, toolOnlyTurn);
    expect(actions.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(
      false,
    );
    expect(actions.some((a) => a.type === "infer")).toBe(true);
  });

  // Critique's exact repro on the original PR: identicalToolFingerprintStreak
  // only compared each turn to the one before it, so an alternating pattern
  // never triggered a pause at any length (proved over 200 turns). Period
  // detection catches the period-2 cycle instead.
  test("catches an alternating A,B tool-call pattern over 200 turns", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();
    const alternatingTurn = (id: string): ReactorInboundEvent => {
      const path = Number(id.split("-")[1]) % 2 === 0 ? "a.ts" : "b.ts";
      return {
        type: "inference.done",
        turn: {
          role: "assistant",
          model: "test",
          timestamp: 0,
          content: [{ type: "tool_call", id, name: "read_file", arguments: { path } }],
        },
        usage: { input: 0, output: 0 },
        source: "test",
      } as unknown as ReactorInboundEvent;
    };

    const actions = await runToolOnlyStreak(director, capabilities, 200, alternatingTurn);
    const reply = actions.find((a) => a.type === "reply" && a.content.includes("Auto-paused"));
    expect(reply).toBeDefined();
  });

  // Period detection generalizes past period 1 and 2: a rotating three-call
  // cycle must also be recognized as thrash.
  test("catches a 3-cycle A,B,C tool-call pattern", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();
    const paths = ["a.ts", "b.ts", "c.ts"];
    const cycleTurn = (id: string): ReactorInboundEvent => {
      const path = paths[Number(id.split("-")[1]) % 3];
      return {
        type: "inference.done",
        turn: {
          role: "assistant",
          model: "test",
          timestamp: 0,
          content: [{ type: "tool_call", id, name: "read_file", arguments: { path } }],
        },
        usage: { input: 0, output: 0 },
        source: "test",
      } as unknown as ReactorInboundEvent;
    };

    const actions = await runToolOnlyStreak(director, capabilities, 12, cycleTurn);
    const reply = actions.find((a) => a.type === "reply" && a.content.includes("Auto-paused"));
    expect(reply).toBeDefined();
  });

  // Period detection is the fast path: for cycles it can see, it must fire
  // — and be identifiable as the fast path, not the backstop — well before
  // the raw-count backstop threshold could ever be reached.
  test("period detection fires as the fast path, not the backstop, on A,B", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();
    const alternatingTurn = (id: string): ReactorInboundEvent => {
      const path = Number(id.split("-")[1]) % 2 === 0 ? "a.ts" : "b.ts";
      return {
        type: "inference.done",
        turn: {
          role: "assistant",
          model: "test",
          timestamp: 0,
          content: [{ type: "tool_call", id, name: "read_file", arguments: { path } }],
        },
        usage: { input: 0, output: 0 },
        source: "test",
      } as unknown as ReactorInboundEvent;
    };

    // A,B,A,B,A,B pauses at 6 turns per the fast-path floors — nowhere near
    // the 100-turn backstop.
    const actions = await runToolOnlyStreak(director, capabilities, 6, alternatingTurn);
    const reply = actions.find((a) => a.type === "reply" && a.content.includes("Auto-paused"));
    expect(reply).toBeDefined();
    if (reply === undefined || reply.type !== "reply") throw new Error("expected reply action");
    expect(reply.content).toContain("repeated a 2-call cycle");
    expect(reply.content).not.toContain("tool-only turns without narrating progress");
  });

  test("period detection fires as the fast path, not the backstop, on A,B,C", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();
    const paths = ["a.ts", "b.ts", "c.ts"];
    const cycleTurn = (id: string): ReactorInboundEvent => {
      const path = paths[Number(id.split("-")[1]) % 3];
      return {
        type: "inference.done",
        turn: {
          role: "assistant",
          model: "test",
          timestamp: 0,
          content: [{ type: "tool_call", id, name: "read_file", arguments: { path } }],
        },
        usage: { input: 0, output: 0 },
        source: "test",
      } as unknown as ReactorInboundEvent;
    };

    // A,B,C cycle pauses at 9 turns per the fast-path floors.
    const actions = await runToolOnlyStreak(director, capabilities, 9, cycleTurn);
    const reply = actions.find((a) => a.type === "reply" && a.content.includes("Auto-paused"));
    expect(reply).toBeDefined();
    if (reply === undefined || reply.type !== "reply") throw new Error("expected reply action");
    expect(reply.content).toContain("repeated a 3-call cycle");
    expect(reply.content).not.toContain("tool-only turns without narrating progress");
  });

  // Required by round 3 (escalation reshaped in round 4): any fixed period
  // ceiling has an escape above it. A 9-element rotation never repeats
  // within TOOL_FINGERPRINT_MAX_PERIOD (8), so period detection can never
  // fire on it — only the backstop can. Round 4: the backstop no longer
  // pauses the first time it fires — it nudges at 100 turns, then only
  // pauses if a further 100 turns pass with still no user message and no
  // thrash detected.
  test("a 9-element rotation escapes period detection, nudges at 100, and escalates to a pause at 200", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();
    const paths = Array.from({ length: 9 }, (_, i) => `f${i}.ts`);
    const rotationTurn = (id: string): ReactorInboundEvent => {
      const path = paths[Number(id.split("-")[1]) % 9];
      return {
        type: "inference.done",
        turn: {
          role: "assistant",
          model: "test",
          timestamp: 0,
          content: [{ type: "tool_call", id, name: "read_file", arguments: { path } }],
        },
        usage: { input: 0, output: 0 },
        source: "test",
      } as unknown as ReactorInboundEvent;
    };

    // 99 turns: below the backstop nudge threshold, still no nudge or pause.
    const before = await runToolOnlyStreak(director, capabilities, 99, rotationTurn);
    expect(before.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(false);
    expect(before.some((a) => a.type === "infer" && ephemeralText(a) !== undefined)).toBe(false);

    // Turn 100: the backstop nudges, but does not pause.
    const nudged = actionsArray(await runToolOnlyStreak(director, capabilities, 1, rotationTurn));
    expect(nudged.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(false);
    const nudgeInfer = nudged.find((a) => a.type === "infer");
    expect(ephemeralText(nudgeInfer)).toContain("progress summary");

    // A further 99 turns without a user message: still no pause (the
    // escalation window has not fully elapsed).
    const stillNoPause = await runToolOnlyStreak(director, capabilities, 99, rotationTurn);
    expect(stillNoPause.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(
      false,
    );

    // Turn 200: the nudge went unheeded for a full further interval — escalate to a pause.
    const actions = actionsArray(await runToolOnlyStreak(director, capabilities, 1, rotationTurn));
    const reply = actions.find((a) => a.type === "reply" && a.content.includes("Auto-paused"));
    expect(reply).toBeDefined();
    if (reply === undefined || reply.type !== "reply") throw new Error("expected reply action");
    expect(reply.content).toContain("turns without a message from the operator");
    expect(reply.content).not.toContain("cycle");
  });

  // Required by round 3 (escalation reshaped in round 4): a "phase-broken"
  // cycle inserts one varying element per window (A,B,A,B,UNIQUE,...), so the
  // fingerprint tail never settles into an exact repeat at any period —
  // period detection can never fire, but the backstop nudge-then-escalate
  // path still catches it.
  test("a phase-broken cycle escapes period detection and eventually escalates to a pause via the backstop", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();
    const phaseBrokenTurn = (id: string): ReactorInboundEvent => {
      const i = Number(id.split("-")[1]);
      const window = i % 5;
      const path =
        window === 0
          ? "a.ts"
          : window === 1
            ? "b.ts"
            : window === 2
              ? "a.ts"
              : window === 3
                ? "b.ts"
                : `unique-${i}.ts`;
      return {
        type: "inference.done",
        turn: {
          role: "assistant",
          model: "test",
          timestamp: 0,
          content: [{ type: "tool_call", id, name: "read_file", arguments: { path } }],
        },
        usage: { input: 0, output: 0 },
        source: "test",
      } as unknown as ReactorInboundEvent;
    };

    const actions = await runToolOnlyStreak(director, capabilities, 201, phaseBrokenTurn);
    const reply = actions.find((a) => a.type === "reply" && a.content.includes("Auto-paused"));
    expect(reply).toBeDefined();
    if (reply === undefined || reply.type !== "reply") throw new Error("expected reply action");
    expect(reply.content).toContain("turns without a message from the operator");
    expect(reply.content).not.toContain("cycle");
  });

  // Required by round 3/4: the backstop nudge threshold is well above any
  // legitimate streak length in the forensic data — long varied productive
  // work must not pause, or even be nudged, before it.
  test("long varied productive work does not pause or nudge before the backstop threshold", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    const actions = await runToolOnlyStreak(director, capabilities, 99);
    expect(actions.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(
      false,
    );
    expect(actions.some((a) => a.type === "infer")).toBe(true);
  });

  // Required by round 4: the operator explicitly wants long autonomous runs
  // to keep going as long as the operator stays engaged. Periodic genuine
  // user messages reset turnsSinceUserMessage, so a long run interleaved
  // with real interaction must never reach the backstop, however many total
  // turns it accumulates.
  test("long varied productive work with real periodic user interaction never pauses", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    for (let round = 0; round < 5; round++) {
      await director.decide(messageReceived(`keep going, round ${round}`), mockState, capabilities);
      const actions = await runToolOnlyStreak(director, capabilities, 80);
      expect(actions.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(
        false,
      );
    }
  });

  // Round 4 regression test: critique's exact escape — one narrated word
  // every ~55 tool-only turns kept resetting BOTH toolFingerprintHistory and
  // the old raw backstop counter, so a 2240-turn run never paused. With the
  // reset split, narration still clears period-detection history (so no
  // false thrash pause), but no longer touches turnsSinceUserMessage, so the
  // backstop nudges at 100 and, since narration keeps arriving instead of a
  // real user message, escalates to a pause at 200.
  test("critique's 2240-turn one-narrated-word-every-55-turns repro now nudges then pauses", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    let nudged = false;
    let paused = false;
    for (let i = 0; i < 2240 && !paused; i++) {
      const id = `tc-${i}`;
      // One narrated word every 55 turns; otherwise a varied tool-only turn.
      const event = i > 0 && i % 55 === 0 ? textAndToolTurn(id, "working") : toolOnlyTurn(id);
      await director.decide(event, mockState, capabilities);
      const result = actionsArray(
        await director.decide(toolDoneEvent(id), mockState, capabilities),
      );
      if (result.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))) {
        paused = true;
      } else if (
        result.some((a) => a.type === "infer" && ephemeralText(a)?.includes("progress summary"))
      ) {
        nudged = true;
      }
    }

    expect(nudged).toBe(true);
    expect(paused).toBe(true);
  });

  test("a genuine fresh user message resets the backstop", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    // Reach the backstop nudge.
    await runToolOnlyStreak(director, capabilities, 100);
    await director.decide(messageReceived("status check"), mockState, capabilities);
    // After the reset, a further 99 turns (below the threshold again) must
    // not nudge or pause.
    const afterReset = await runToolOnlyStreak(director, capabilities, 99);
    expect(afterReset.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(
      false,
    );
    expect(
      afterReset.some((a) => a.type === "infer" && ephemeralText(a)?.includes("progress summary")),
    ).toBe(false);
  });

  // Round 5: round 4 reset turnsSinceUserMessage on any message.received,
  // which is also satisfied by the synthetic content-less messages the
  // runner delivers itself after compaction — and compaction fires more
  // during long tool-only loops, i.e. exactly when the backstop should be
  // counting. Prove the fix against the real production message builders,
  // not a hand-rolled shape that merely looks synthetic, at all three call
  // sites named in the round-4 critique.
  for (const [label, build] of [
    ["tui/runner.ts:1174", tuiCompactionContinuation],
    ["exec/runner.ts:418", execCompactionContinuation],
    ["subagent/run.ts:367", subagentCompactionContinuation],
  ] as const) {
    test(`a synthetic compaction continuation from ${label} does not reset the backstop`, async () => {
      const director = createChatDirector("system", [], {
        onTasksChange: () => {},
        provider: providerlessPolicy,
      });
      const capabilities = makeCapabilities();

      // Reach the backstop nudge, then deliver the real synthetic message
      // this call site actually produces.
      await runToolOnlyStreak(director, capabilities, 100);
      await director.decide(systemMessageReceived(build()), mockState, capabilities);

      // If the synthetic message had reset turnsSinceUserMessage, a further
      // 99 turns would stay quiet indefinitely. It must not: escalation
      // still lands exactly 100 turns after the nudge, same as if the
      // synthetic message had never arrived.
      const stillNoPause = await runToolOnlyStreak(director, capabilities, 99);
      expect(
        stillNoPause.some((a) => a.type === "reply" && a.content.includes("Auto-paused")),
      ).toBe(false);

      const actions = actionsArray(await runToolOnlyStreak(director, capabilities, 1));
      const reply = actions.find((a) => a.type === "reply" && a.content.includes("Auto-paused"));
      expect(reply).toBeDefined();
    });
  }

  test("a genuine operator submit does reset the backstop even after a synthetic message arrived", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    await runToolOnlyStreak(director, capabilities, 100);
    // A synthetic message arrives first (e.g. a compaction continuation
    // mid-loop) — must not reset anything.
    await director.decide(
      systemMessageReceived(tuiCompactionContinuation()),
      mockState,
      capabilities,
    );
    // Then the operator actually sends something.
    await director.decide(messageReceived("status check"), mockState, capabilities);

    const afterReset = await runToolOnlyStreak(director, capabilities, 99);
    expect(afterReset.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(
      false,
    );
    expect(
      afterReset.some((a) => a.type === "infer" && ephemeralText(a)?.includes("progress summary")),
    ).toBe(false);
  });

  // Round 4: narration clears period-detection history (evidence the model
  // isn't cycling) but must NOT clear turnsSinceUserMessage — otherwise a
  // model can narrate its way past the backstop forever without ever
  // sending anything the operator asked for.
  test("model narration does not reset the backstop but does clear period-detection history", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    // Build up an almost-thrashing repeated-fingerprint run, then narrate —
    // this must clear the fingerprint history (no thrash pause even after
    // more repeats) while still counting toward the backstop.
    await runToolOnlyStreak(director, capabilities, 4, repeatedToolOnlyTurn);
    const narrated = actionsArray(
      await director.decide(
        textAndToolTurn("narrate-1", "still working on it"),
        mockState,
        capabilities,
      ),
    );
    await director.decide(toolDoneEvent("narrate-1"), mockState, capabilities);
    expect(narrated.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(
      false,
    );

    // Resume the repeated-fingerprint run — since history was cleared, it
    // takes a fresh IDENTICAL_REPEAT_MIN-length run to thrash-pause again,
    // and it must not reference the backstop when it does.
    const afterNarration = await runToolOnlyStreak(director, capabilities, 5, repeatedToolOnlyTurn);
    const thrashReply = afterNarration.find(
      (a) => a.type === "reply" && a.content.includes("Auto-paused"),
    );
    expect(thrashReply).toBeDefined();
    if (thrashReply === undefined || thrashReply.type !== "reply")
      throw new Error("expected reply action");
    expect(thrashReply.content).not.toContain("turns without a message from the operator");

    // Now prove narration did NOT reset turnsSinceUserMessage: drain the
    // remaining budget to the backstop threshold with varied tool-only turns
    // and a fresh director for a clean count, interleaving narration every
    // few turns, and confirm the backstop still nudges at the expected
    // total turn count rather than being pushed back out by narration.
    const fresh = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    let nudgedAtTurn: number | null = null;
    for (let i = 0; i < 100; i++) {
      const id = `fc-${i}`;
      const event = i % 10 === 0 ? textAndToolTurn(id, "narrating") : toolOnlyTurn(id);
      await fresh.decide(event, mockState, capabilities);
      const result = actionsArray(await fresh.decide(toolDoneEvent(id), mockState, capabilities));
      if (
        nudgedAtTurn === null &&
        result.some((a) => a.type === "infer" && ephemeralText(a)?.includes("progress summary"))
      ) {
        nudgedAtTurn = i + 1;
      }
    }
    // Exactly 100 total turns (narrated or not) trips the backstop nudge —
    // proving narration advanced turnsSinceUserMessage rather than resetting
    // it, since 10 of those 100 turns were narrated.
    expect(nudgedAtTurn).toBe(100);
  });

  test("resumes after the operator sends a new message", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    await runToolOnlyStreak(director, capabilities, 5, repeatedToolOnlyTurn);
    await director.decide(messageReceived("keep going"), mockState, capabilities);
    // A fresh tool-only streak from zero must not immediately re-pause.
    const actions = await runToolOnlyStreak(director, capabilities, 1, repeatedToolOnlyTurn);
    expect(actions.some((a) => a.type === "reply")).toBe(false);
  });

  test("a dismissed ask_operator counts toward the streak like any other tool-only turn", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    // 24 ordinary (varied) tool-only turns, then a turn whose only tool call
    // is a declined ask_operator — the streak must still reach the nudge
    // threshold on turn 25, exactly as if it were any other tool call.
    for (let i = 0; i < 24; i++) {
      const id = `tc-${i}`;
      await director.decide(toolOnlyTurn(id), mockState, capabilities);
      await director.decide(toolDoneEvent(id), mockState, capabilities);
    }
    const askId = "ask-1";
    await director.decide(
      {
        type: "inference.done",
        turn: {
          role: "assistant",
          model: "test",
          timestamp: 0,
          content: [
            {
              type: "tool_call",
              id: askId,
              name: "ask_operator",
              arguments: { question: "?", options: ["a"] },
            },
          ],
        },
        usage: { input: 0, output: 0 },
        source: "test",
      } as unknown as ReactorInboundEvent,
      mockState,
      capabilities,
    );
    const declined = actionsArray(
      await director.decide(
        {
          type: "tool.done",
          result: {
            callId: askId,
            isError: true,
            content: "Blocked by permission policy: Operator declined:",
          },
        } as unknown as ReactorInboundEvent,
        mockState,
        capabilities,
      ),
    );
    // The declined branch returns its own reply, short-circuiting this cycle;
    // the streak nonetheless already reached 25 and fires on the next infer.
    expect(declined.some((a) => a.type === "reply")).toBe(true);
    const followUp = actionsArray(await runToolOnlyStreak(director, capabilities, 1));
    const infer = followUp.find((a) => a.type === "infer");
    expect(ephemeralText(infer)).toBeDefined();
  });

  test("a busy-but-progressing session (text interleaved with tools) never trips", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    let lastActions: ReactorAction[] = [];
    for (let i = 0; i < 40; i++) {
      const id = `tc-${i}`;
      await director.decide(textAndToolTurn(id, `Working on step ${i}.`), mockState, capabilities);
      lastActions = actionsArray(await director.decide(toolDoneEvent(id), mockState, capabilities));
    }
    expect(lastActions.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(
      false,
    );
    const infer = lastActions.find((a) => a.type === "infer");
    expect(ephemeralText(infer)).toBeUndefined();
  });

  // Required by CL-5611: the observed failure — a Grok session hard-paused
  // at 10 turns of real progress (Linear lookups + code reads).
  test("grok no longer hard-pauses a 10-turn productive tool-only streak", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: { providerName: "xai/default", model: "grok-4.5" },
    });
    const capabilities = makeCapabilities();

    const actions = await runToolOnlyStreak(director, capabilities, 10);
    expect(actions.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(
      false,
    );
    expect(actions.some((a) => a.type === "infer")).toBe(true);
  });

  test("grok still catches genuine no-progress thrash", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: { providerName: "xai/default", model: "grok-4.5" },
    });
    const capabilities = makeCapabilities();

    const actions = await runToolOnlyStreak(director, capabilities, 5, repeatedToolOnlyTurn);
    expect(actions.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(true);
  });

  // Required by CL-5611: the nudge is an ephemeral inference-side prompt, not
  // a reply — it must never itself pause/end the session.
  test("the nudge path does not reply-pause the session", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    const actions = await runToolOnlyStreak(director, capabilities, 25);
    expect(actions.some((a) => a.type === "reply")).toBe(false);
    expect(actions.some((a) => a.type === "infer")).toBe(true);
  });

  test("after a hard-block salvage, Skywalker is nudged once and unique reads do not pause", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();
    const salvage = forcedStopReport("no-ship", "mapped the tree, never edited");
    await director.decide(
      {
        type: "inference.done",
        turn: {
          role: "assistant",
          model: "test",
          timestamp: 0,
          content: [{ type: "tool_call", id: "task-1", name: "task", arguments: {} }],
        },
        usage: { input: 0, output: 0 },
        source: "test",
      } as unknown as ReactorInboundEvent,
      mockState,
      capabilities,
    );
    const afterSalvage = actionsArray(
      await director.decide(
        {
          type: "tool.done",
          result: { callId: "task-1", content: salvage },
        } as unknown as ReactorInboundEvent,
        mockState,
        capabilities,
      ),
    );
    expect(ephemeralText(afterSalvage.find((a) => a.type === "infer"))).toContain(
      "stopped without finishing",
    );

    const later = await runToolOnlyStreak(director, capabilities, 20, toolOnlyTurn);
    expect(later.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(false);
    expect(later.some((a) => a.type === "infer")).toBe(true);
  });

  // CL-5893: the primary is productively blocked on a long stream of task
  // dispatches — each successful leaf completion is progress the operator
  // will see, so it must re-arm the backstop interval regardless of how many
  // parent turns (tool.done -> infer cycles) that takes in total.
  describe("CL-5893: successful leaf task completions re-arm the backstop", () => {
    test("a back-to-back streak of successful task completions is bounded — the cap exhausts and the nudge/pause escalation eventually fires", async () => {
      const director = createChatDirector("system", [], {
        onTasksChange: () => {},
        provider: providerlessPolicy,
      });
      const capabilities = makeCapabilities();

      // Every success here lands one turn after the last reset, so the
      // MAX_LEAF_PROGRESS_BACKSTOP_RESETS credits are consumed almost
      // immediately (the worst case for the bound — a genuinely spaced-out
      // fleet gets far more turns before exhausting the same cap). Once
      // exhausted, successes stop resetting the interval and the ordinary
      // nudge (at the 100-turn threshold) then pause (a further 100 turns
      // unheeded) fire on schedule.
      let nudgedAt: number | null = null;
      let pausedAt: number | null = null;
      for (let i = 0; i < 300 && pausedAt === null; i++) {
        const id = `task-ok-${i}`;
        await director.decide(taskTurn(id), mockState, capabilities);
        const result = actionsArray(
          await director.decide(taskDoneEvent(id), mockState, capabilities),
        );
        if (result.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))) {
          pausedAt = i;
        } else if (
          nudgedAt === null &&
          result.some((a) => a.type === "infer" && ephemeralText(a)?.includes("progress summary"))
        ) {
          nudgedAt = i;
        }
      }

      expect(nudgedAt).not.toBeNull();
      expect(pausedAt).not.toBeNull();
      // A runaway trivial-success loop still pauses — it just gets the cap's
      // worth of extra headroom first, well past the plain 100-turn
      // threshold, before the escalation is forced.
      expect(pausedAt as number).toBeGreaterThan(150);
    });

    test("an operator message re-arms the full leaf-progress cap", async () => {
      const director = createChatDirector("system", [], {
        onTasksChange: () => {},
        provider: providerlessPolicy,
      });
      const capabilities = makeCapabilities();

      // Exhaust the cap with MAX_LEAF_PROGRESS_BACKSTOP_RESETS (5) successes.
      for (let i = 0; i < 5; i++) {
        const id = `task-ok-a-${i}`;
        await director.decide(taskTurn(id), mockState, capabilities);
        await director.decide(taskDoneEvent(id), mockState, capabilities);
      }

      await director.decide(messageReceived(), mockState, capabilities);

      // If the cap were not re-armed by the operator message, all 100 of
      // these would get zero credit and turnsSinceUserMessage would climb
      // straight to the 100-turn nudge threshold by the last iteration. With
      // the cap re-armed, the first 5 are credited again (holding the
      // interval near zero) and the remaining 95 only climb to 95 — no
      // nudge or pause.
      let sawPauseOrNudge = false;
      for (let i = 0; i < 100; i++) {
        const id = `task-ok-b-${i}`;
        await director.decide(taskTurn(id), mockState, capabilities);
        const result = actionsArray(
          await director.decide(taskDoneEvent(id), mockState, capabilities),
        );
        if (
          result.some((a) => a.type === "reply" && a.content.includes("Auto-paused")) ||
          result.some((a) => a.type === "infer" && ephemeralText(a)?.includes("progress summary"))
        ) {
          sawPauseOrNudge = true;
        }
      }
      expect(sawPauseOrNudge).toBe(false);
    });

    test("non-string tool result content gets no backstop credit — the backstop still nudges then pauses", async () => {
      const director = createChatDirector("system", [], {
        onTasksChange: () => {},
        provider: providerlessPolicy,
      });
      const capabilities = makeCapabilities();

      let nudged = false;
      let paused = false;
      for (let i = 0; i < 200 && !paused; i++) {
        const id = `task-nonstring-${i}`;
        await director.decide(taskTurn(id), mockState, capabilities);
        const result = actionsArray(
          await director.decide(
            {
              type: "tool.done",
              result: { callId: id, isError: false, content: undefined },
            } as unknown as ReactorInboundEvent,
            mockState,
            capabilities,
          ),
        );
        if (result.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))) {
          paused = true;
        } else if (
          result.some((a) => a.type === "infer" && ephemeralText(a)?.includes("progress summary"))
        ) {
          nudged = true;
        }
      }
      expect(nudged).toBe(true);
      expect(paused).toBe(true);
    });

    test("periodic successful task completions amid other tool-only turns keep resetting the backstop", async () => {
      const director = createChatDirector("system", [], {
        onTasksChange: () => {},
        provider: providerlessPolicy,
      });
      const capabilities = makeCapabilities();

      let sawPauseOrNudge = false;
      for (let round = 0; round < 5; round++) {
        // 80 varied tool-only turns per round — below the 100 threshold on
        // their own, and would accumulate past it across rounds without a
        // reset.
        const actions = await runToolOnlyStreak(director, capabilities, 80);
        if (
          actions.some((a) => a.type === "reply" && a.content.includes("Auto-paused")) ||
          actions.some((a) => a.type === "infer" && ephemeralText(a)?.includes("progress summary"))
        ) {
          sawPauseOrNudge = true;
        }
        // A successful task completion lands at the end of the round and
        // must reset the interval before the next round starts.
        const id = `task-round-${round}`;
        await director.decide(taskTurn(id), mockState, capabilities);
        await director.decide(taskDoneEvent(id), mockState, capabilities);
      }
      expect(sawPauseOrNudge).toBe(false);
    });

    test("failed task completions get no progress credit — the backstop still nudges then pauses", async () => {
      const director = createChatDirector("system", [], {
        onTasksChange: () => {},
        provider: providerlessPolicy,
      });
      const capabilities = makeCapabilities();

      let nudged = false;
      let paused = false;
      for (let i = 0; i < 200 && !paused; i++) {
        const id = `task-fail-${i}`;
        await director.decide(taskTurn(id), mockState, capabilities);
        const result = actionsArray(
          await director.decide(
            taskDoneEvent(id, { isError: true, content: "boom" }),
            mockState,
            capabilities,
          ),
        );
        if (result.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))) {
          paused = true;
        } else if (
          result.some((a) => a.type === "infer" && ephemeralText(a)?.includes("progress summary"))
        ) {
          nudged = true;
        }
      }
      expect(nudged).toBe(true);
      expect(paused).toBe(true);
    });

    test("a task completion without a tool error but carrying a salvage envelope is not counted as progress", async () => {
      const director = createChatDirector("system", [], {
        onTasksChange: () => {},
        provider: providerlessPolicy,
      });
      const capabilities = makeCapabilities();

      let paused = false;
      for (let i = 0; i < 200 && !paused; i++) {
        const id = `task-salvage-${i}`;
        await director.decide(taskTurn(id), mockState, capabilities);
        const result = actionsArray(
          await director.decide(
            taskDoneEvent(id, { content: forcedStopReport("no-progress", "x") }),
            mockState,
            capabilities,
          ),
        );
        if (result.some((a) => a.type === "reply" && a.content.includes("Auto-paused")))
          paused = true;
      }
      expect(paused).toBe(true);
    });
  });
});

// CL-6910: the harness's own retry policy (vendor/intx-inference/src/
// retry-policy.ts) already owns `timeout`/`retryable`/`quota_exhausted` and
// exhausts its full attempt budget (3 attempts) before an `inference.error`
// of one of those categories ever reaches the director. The director must
// not re-wrap those categories in another `capabilities.infer()` call — that
// multiplied the two layers' attempt budgets (up to 9 identical full-context
// sends per turn) instead of composing them. `aborted` (internal-recovery)
// is the one category the harness never retries at all, so it remains the
// director's to recover, and that recovery does not compound with harness
// attempts.
function inferenceErrorEvent(
  category: "retryable" | "timeout" | "aborted" | "quota_exhausted",
  raw?: unknown,
): ReactorInboundEvent {
  return {
    type: "inference.error",
    error: { category, message: "boom", raw },
  } as unknown as ReactorInboundEvent;
}

describe("ChatDirector inference-error recovery (CL-6910)", () => {
  const providerlessPolicy = { providerName: "test-provider" };

  test.each(["retryable", "timeout", "quota_exhausted"] as const)(
    "does not re-issue inference for a %s error already exhausted by the harness",
    async (category) => {
      const director = createChatDirector("system", [], {
        onTasksChange: () => {},
        provider: providerlessPolicy,
      });
      const capabilities = makeCapabilities();

      const actions = actionsArray(
        await director.decide(inferenceErrorEvent(category), mockState, capabilities),
      );

      // No additional full-context send: the base director's terminal
      // checkpoint + reply is the only outcome, not another `infer`.
      expect(actions.some((a) => a.type === "infer")).toBe(false);
      expect(actions.some((a) => a.type === "reply")).toBe(true);
    },
  );

  test("still recovers on internal-recovery abort, bounded by MAX_INFERENCE_RECOVERIES", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();
    const internalAbort = inferenceErrorEvent("aborted", { origin: "internal-recovery" });

    // Recovery 1 of 2: re-issues inference.
    const first = actionsArray(await director.decide(internalAbort, mockState, capabilities));
    expect(first.some((a) => a.type === "infer")).toBe(true);

    // Recovery 2 of 2: re-issues inference.
    const second = actionsArray(await director.decide(internalAbort, mockState, capabilities));
    expect(second.some((a) => a.type === "infer")).toBe(true);

    // Budget exhausted: no further infer, terminal reply instead.
    const third = actionsArray(await director.decide(internalAbort, mockState, capabilities));
    expect(third.some((a) => a.type === "infer")).toBe(false);
    expect(third.some((a) => a.type === "reply")).toBe(true);
  });

  test("an unrelated aborted error (not internal-recovery) is not recovered by the director", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    const actions = actionsArray(
      await director.decide(
        inferenceErrorEvent("aborted", { origin: "user-stop" }),
        mockState,
        capabilities,
      ),
    );
    expect(actions.some((a) => a.type === "infer")).toBe(false);
  });

  test("inference-recovery budget resets at the next turn boundary", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();
    const internalAbort = inferenceErrorEvent("aborted", { origin: "internal-recovery" });

    await director.decide(internalAbort, mockState, capabilities);
    await director.decide(internalAbort, mockState, capabilities);
    // Budget exhausted for this turn.
    const exhausted = actionsArray(await director.decide(internalAbort, mockState, capabilities));
    expect(exhausted.some((a) => a.type === "infer")).toBe(false);

    // A fresh turn boundary (inference.done) resets the budget.
    await director.decide(toolOnlyTurn("post-boundary"), mockState, capabilities);
    const afterBoundary = actionsArray(
      await director.decide(internalAbort, mockState, capabilities),
    );
    expect(afterBoundary.some((a) => a.type === "infer")).toBe(true);
  });

  // Bounds the worst-case number of on-wire full-context sends per logical
  // turn across the two layers that can legitimately fire: the harness's
  // own retry policy (up to 3 attempts per `infer()` call — see
  // vendor/intx-inference/src/retry-policy.ts MAX_ATTEMPTS) and the
  // director's internal-recovery-only budget (up to 2 extra `infer()`
  // calls). Before this fix, `retryable`/`timeout` re-entered this same
  // director budget on top of the harness's exhausted 3, multiplying to 9.
  // After this fix, `retryable`/`timeout`/`quota_exhausted` are harness-only
  // (bounded at 3, asserted against createDefaultRetryPolicy behavior in
  // retry-policy.test.ts), and `aborted` is director-only: each of the
  // director's up-to-3 infer() calls (1 initial + 2 recoveries) is a single
  // harness attempt because the harness's own policy never retries
  // `aborted`. Worst case across a turn that alternates categories is
  // bounded, not open-ended, and never reaches 9.
  test("worst case: director-owned recovery path issues at most 1 + MAX_INFERENCE_RECOVERIES infer calls", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();
    const internalAbort = inferenceErrorEvent("aborted", { origin: "internal-recovery" });

    let inferCount = 0;
    for (let i = 0; i < 10; i++) {
      const actions = actionsArray(await director.decide(internalAbort, mockState, capabilities));
      if (actions.some((a) => a.type === "infer")) inferCount++;
      else break;
    }
    expect(inferCount).toBe(2); // MAX_INFERENCE_RECOVERIES
  });

  test("timeout category produces the timeout preamble, not the fatal fallback", async () => {
    const director = createChatDirector("system", [], {
      onTasksChange: () => {},
      provider: providerlessPolicy,
    });
    const capabilities = makeCapabilities();

    const actions = actionsArray(
      await director.decide(inferenceErrorEvent("timeout"), mockState, capabilities),
    );
    const reply = actions.find((a) => a.type === "reply");
    expect(reply).toBeDefined();
    expect((reply as { content: string }).content).toContain("did not respond in time");
    expect((reply as { content: string }).content).not.toContain("unrecoverable inference error");
  });
});
