import { describe, expect, test } from "bun:test";
import type {
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
  ReactorState,
} from "@intx/types/runtime";
import { createChatDirector } from "./director.js";

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

function messageReceived(content = "hello"): ReactorInboundEvent {
  return {
    type: "message.received",
    message: { content },
  } as unknown as ReactorInboundEvent;
}

function actionsArray(result: ReactorAction | ReactorAction[]): ReactorAction[] {
  return Array.isArray(result) ? result : [result];
}

function ephemeralText(action: ReactorAction | undefined): string | undefined {
  if (action === undefined || action.type !== "infer") return undefined;
  const opts = action.options as { ephemeralTurns?: Array<{ content: Array<{ text?: string }> }> } | undefined;
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
    const director = createChatDirector(
      "system",
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      providerlessPolicy,
    );
    const capabilities = makeCapabilities();

    // Default family nudges at 25 consecutive tool-only turns.
    const actions = await runToolOnlyStreak(director, capabilities, 25);
    const infer = actions.find((a) => a.type === "infer");
    expect(infer).toBeDefined();
    expect(ephemeralText(infer)).toBeDefined();
  });

  test("the nudge is one-shot — it does not repeat on the next tool-only turn", async () => {
    const director = createChatDirector(
      "system",
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      providerlessPolicy,
    );
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
    const director = createChatDirector(
      "system",
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      providerlessPolicy,
    );
    const capabilities = makeCapabilities();

    const actions = await runToolOnlyStreak(director, capabilities, 50);
    expect(actions.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(false);
    expect(actions.some((a) => a.type === "infer")).toBe(true);
  });

  // Required by CL-5611 (reworked): genuine no-progress (identical tool
  // fingerprint repeating) must still be caught and stop the session. The
  // period-1 (identical-consecutive) repeat floor is 5, not 4 — see
  // "does not pause after 4 identical polls" below for why 4 must not fire.
  test("pauses when the same tool call repeats without progress", async () => {
    const director = createChatDirector(
      "system",
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      providerlessPolicy,
    );
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
    const director = createChatDirector(
      "system",
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      providerlessPolicy,
    );
    const capabilities = makeCapabilities();

    await runToolOnlyStreak(director, capabilities, 4, repeatedToolOnlyTurn);
    const actions = await runToolOnlyStreak(director, capabilities, 3, toolOnlyTurn);
    expect(actions.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(false);
    expect(actions.some((a) => a.type === "infer")).toBe(true);
  });

  // Critique's exact repro on the original PR: identicalToolFingerprintStreak
  // only compared each turn to the one before it, so an alternating pattern
  // never triggered a pause at any length (proved over 200 turns). Period
  // detection catches the period-2 cycle instead.
  test("catches an alternating A,B tool-call pattern over 200 turns", async () => {
    const director = createChatDirector(
      "system",
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      providerlessPolicy,
    );
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
    const director = createChatDirector(
      "system",
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      providerlessPolicy,
    );
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

  test("resumes after the operator sends a new message", async () => {
    const director = createChatDirector(
      "system",
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      providerlessPolicy,
    );
    const capabilities = makeCapabilities();

    await runToolOnlyStreak(director, capabilities, 5, repeatedToolOnlyTurn);
    await director.decide(messageReceived("keep going"), mockState, capabilities);
    // A fresh tool-only streak from zero must not immediately re-pause.
    const actions = await runToolOnlyStreak(director, capabilities, 1, repeatedToolOnlyTurn);
    expect(actions.some((a) => a.type === "reply")).toBe(false);
  });

  test("a dismissed ask_operator counts toward the streak like any other tool-only turn", async () => {
    const director = createChatDirector(
      "system",
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      providerlessPolicy,
    );
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
          content: [{ type: "tool_call", id: askId, name: "ask_operator", arguments: { question: "?", options: ["a"] } }],
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
    const director = createChatDirector(
      "system",
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      providerlessPolicy,
    );
    const capabilities = makeCapabilities();

    let lastActions: ReactorAction[] = [];
    for (let i = 0; i < 40; i++) {
      const id = `tc-${i}`;
      await director.decide(textAndToolTurn(id, `Working on step ${i}.`), mockState, capabilities);
      lastActions = actionsArray(await director.decide(toolDoneEvent(id), mockState, capabilities));
    }
    expect(lastActions.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(false);
    const infer = lastActions.find((a) => a.type === "infer");
    expect(ephemeralText(infer)).toBeUndefined();
  });

  // Required by CL-5611: the observed failure — a Grok session hard-paused
  // at 10 turns of real progress (Linear lookups + code reads).
  test("grok no longer hard-pauses a 10-turn productive tool-only streak", async () => {
    const director = createChatDirector(
      "system",
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { providerName: "xai/default", model: "grok-4.5" },
    );
    const capabilities = makeCapabilities();

    const actions = await runToolOnlyStreak(director, capabilities, 10);
    expect(actions.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(false);
    expect(actions.some((a) => a.type === "infer")).toBe(true);
  });

  test("grok still catches genuine no-progress thrash", async () => {
    const director = createChatDirector(
      "system",
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { providerName: "xai/default", model: "grok-4.5" },
    );
    const capabilities = makeCapabilities();

    const actions = await runToolOnlyStreak(director, capabilities, 5, repeatedToolOnlyTurn);
    expect(actions.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(true);
  });

  // Required by CL-5611: the nudge is an ephemeral inference-side prompt, not
  // a reply — it must never itself pause/end the session.
  test("the nudge path does not reply-pause the session", async () => {
    const director = createChatDirector(
      "system",
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      providerlessPolicy,
    );
    const capabilities = makeCapabilities();

    const actions = await runToolOnlyStreak(director, capabilities, 25);
    expect(actions.some((a) => a.type === "reply")).toBe(false);
    expect(actions.some((a) => a.type === "infer")).toBe(true);
  });
});
