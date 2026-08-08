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

function toolOnlyTurn(id: string): ReactorInboundEvent {
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
): Promise<ReactorAction[]> {
  let last: ReactorAction[] = [];
  for (let i = 0; i < count; i++) {
    const id = `tc-${i}`;
    await director.decide(toolOnlyTurn(id), mockState, capabilities);
    last = actionsArray(await director.decide(toolDoneEvent(id), mockState, capabilities));
  }
  return last;
}

describe("ChatDirector tool-only loop protection", () => {
  const providerlessPolicy = { providerName: "test-provider" };

  test("nudges once at the family threshold, after pending tools execute", async () => {
    const director = createChatDirector("system", [], { provider: providerlessPolicy });
    const capabilities = makeCapabilities();

    // Default family nudges at 12 consecutive tool-only turns.
    const actions = await runToolOnlyStreak(director, capabilities, 12);
    const infer = actions.find((a) => a.type === "infer");
    expect(infer).toBeDefined();
    expect(ephemeralText(infer)).toBeDefined();
  });

  test("the nudge is one-shot — it does not repeat on the next tool-only turn", async () => {
    const director = createChatDirector("system", [], { provider: providerlessPolicy });
    const capabilities = makeCapabilities();

    await runToolOnlyStreak(director, capabilities, 12);
    const nextTurn = actionsArray(await runToolOnlyStreak(director, capabilities, 1));
    const infer = nextTurn.find((a) => a.type === "infer");
    expect(infer).toBeDefined();
    expect(ephemeralText(infer)).toBeUndefined();
  });

  test("pauses and stops issuing infers at the family pause threshold", async () => {
    const director = createChatDirector("system", [], { provider: providerlessPolicy });
    const capabilities = makeCapabilities();

    // Default family pauses at 20 consecutive tool-only turns.
    const actions = await runToolOnlyStreak(director, capabilities, 20);
    expect(actions.some((a) => a.type === "infer")).toBe(false);
    const reply = actions.find((a) => a.type === "reply");
    expect(reply).toBeDefined();
    if (reply === undefined || reply.type !== "reply") throw new Error("expected reply action");
    expect(reply.content).toContain("Auto-paused");
    expect(reply.content).toContain("Send a message to resume");
  });

  test("resumes after the operator sends a new message", async () => {
    const director = createChatDirector("system", [], { provider: providerlessPolicy });
    const capabilities = makeCapabilities();

    await runToolOnlyStreak(director, capabilities, 20);
    await director.decide(messageReceived("keep going"), mockState, capabilities);
    // A fresh tool-only streak from zero must not immediately re-pause.
    const actions = await runToolOnlyStreak(director, capabilities, 1);
    expect(actions.some((a) => a.type === "reply")).toBe(false);
  });

  test("a dismissed ask_operator counts toward the streak like any other tool-only turn", async () => {
    const director = createChatDirector("system", [], { provider: providerlessPolicy });
    const capabilities = makeCapabilities();

    // 11 ordinary tool-only turns, then a turn whose only tool call is a
    // declined ask_operator — the streak must still reach the nudge
    // threshold on turn 12, exactly as if it were any other tool call.
    for (let i = 0; i < 11; i++) {
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
    // the streak nonetheless already reached 12 and fires on the next infer.
    expect(declined.some((a) => a.type === "reply")).toBe(true);
    const followUp = actionsArray(await runToolOnlyStreak(director, capabilities, 1));
    const infer = followUp.find((a) => a.type === "infer");
    expect(ephemeralText(infer)).toBeDefined();
  });

  test("a busy-but-progressing session (text interleaved with tools) never trips", async () => {
    const director = createChatDirector("system", [], { provider: providerlessPolicy });
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

  test("grok's tightened thresholds fire earlier than the default family", async () => {
    const director = createChatDirector("system", [], { provider: { providerName: "xai/default", model: "grok-4.5" } });
    const capabilities = makeCapabilities();

    // Grok nudges at 6, well below the default family's 12.
    const actions = await runToolOnlyStreak(director, capabilities, 6);
    const infer = actions.find((a) => a.type === "infer");
    expect(ephemeralText(infer)).toBeDefined();
  });
});
