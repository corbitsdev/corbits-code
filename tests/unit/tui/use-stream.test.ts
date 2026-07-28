import { test, expect } from "bun:test";
import { createAgentStreamState } from "../../../src/tui/use-stream.js";
import { setActivePricingCache } from "../../../src/cost/cost-visibility.js";
import type { ReactorEmittedEvent } from "@intx/inference";
import { INFERENCE_ABORT_INTERNAL_RECOVERY } from "../../../src/inference-abort.js";

const usageEvent = (input: number, output: number): ReactorEmittedEvent =>
  ({
    type: "inference.usage",
    seq: 1,
    data: { usage: { input, output, cacheRead: 0, cacheWrite: 0, thinking: 0 } },
  }) as unknown as ReactorEmittedEvent;

test("prices the first session at the live model rate", () => {
  setActivePricingCache({
    timestamp: 0,
    models: {
      "expensive-model": { inputPricePerToken: 0.001, outputPricePerToken: 0.002, cacheReadPricePerToken: 0 },
    },
  });
  const state = createAgentStreamState([], () => "expensive-model");
  // First session — no clear() — must already use the resolver, not the default rate.
  state.addEvent(usageEvent(1000, 500));
  expect(state.totalCost).toBeCloseTo(1000 * 0.001 + 500 * 0.002, 10);
  setActivePricingCache(null);
});

test("an unknown model falls back to the default rate", () => {
  setActivePricingCache({ timestamp: 0, models: {} });
  const state = createAgentStreamState([], () => "mystery-model");
  state.addEvent(usageEvent(1000, 0));
  expect(state.totalCost).toBeCloseTo(1000 * 0.000002, 10);
  setActivePricingCache(null);
});

test("createAgentStreamState initial state is empty", () => {
  const state = createAgentStreamState();
  expect(state.contentBlocks.length).toBe(0);
  expect(state.turnsUsed).toBe(0);
  expect(state.status).toBe("idle");
  expect(state.totalCost).toBe(0);
  expect(state.totalTokens).toBe(0);
  expect(state.hooks).toEqual([]);
});

test("clear resets the transcript, telemetry, and status", () => {
  const state = createAgentStreamState();

  state.addEvent({
    type: "inference.tool_call.start",
    seq: 1,
    data: { name: "read_file", callId: "c1" } as unknown as ReactorEmittedEvent["data"],
  });
  state.addEvent({
    type: "inference.done",
    seq: 2,
    data: {
      turn: { role: "assistant", model: "test", timestamp: 0, content: [] },
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { id: "xai", model: "test" },
    } as unknown as ReactorEmittedEvent["data"],
  });
  expect(state.contentBlocks.length).toBeGreaterThan(0);
  expect(state.turnsUsed).toBeGreaterThan(0);

  state.clear();

  expect(state.contentBlocks.length).toBe(0);
  expect(state.turnsUsed).toBe(0);
  expect(state.totalTokens).toBe(0);
  expect(state.totalCost).toBe(0);
  expect(state.status).toBe("idle");
  expect(state.latestUserMessage).toBe("");
  expect(state.currentPlanStep).toBe(null);
});

test("streamed text deltas reuse the contentBlocks snapshot reference", () => {
  // The last block is mutated in place while a token streams in, so the
  // snapshot array returned by contentBlocks must stay the same reference
  // across those deltas — rebuilding it every token is what made steady-state
  // streaming layout cost grow with transcript length instead of staying
  // O(1). A structural change (a new block appended) must still produce a new
  // reference so consumers relying on identity for change detection see it.
  const state = createAgentStreamState();
  state.addEvent({
    type: "inference.text.delta",
    seq: 1,
    data: { token: "hello " } as unknown as ReactorEmittedEvent["data"],
  });
  const first = state.contentBlocks;
  expect(first.length).toBe(1);
  expect(first[0].content).toBe("hello ");

  state.addEvent({
    type: "inference.text.delta",
    seq: 2,
    data: { token: "world" } as unknown as ReactorEmittedEvent["data"],
  });
  const second = state.contentBlocks;
  expect(second).toBe(first);
  expect(second[0].content).toBe("hello world");

  state.addEvent({
    type: "inference.tool_call.start",
    seq: 3,
    data: { name: "read_file", callId: "c1" } as unknown as ReactorEmittedEvent["data"],
  });
  const third = state.contentBlocks;
  expect(third).not.toBe(second);
  expect(third.length).toBe(2);
});

test("createAgentStreamState accumulates tool_call events", () => {
  const state = createAgentStreamState();

  const event: ReactorEmittedEvent = {
    type: "inference.tool_call.start",
    seq: 1,
    data: { name: "read_file", callId: "c1" } as unknown as ReactorEmittedEvent["data"],
  };

  state.addEvent(event);
  expect(state.contentBlocks.length).toBe(1);
  expect(state.contentBlocks[0].type).toBe("tool_call");
  expect(state.contentBlocks[0].name).toBe("read_file");
});

test("createAgentStreamState counts turns from inference.done", () => {
  const state = createAgentStreamState();

  const event: ReactorEmittedEvent = {
    type: "inference.done",
    seq: 1,
    data: {
      turn: { role: "assistant", model: "test", timestamp: 0, content: [] },
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { id: "xai", model: "test" },
    } as unknown as ReactorEmittedEvent["data"],
  };

  state.addEvent(event);
  expect(state.turnsUsed).toBe(1);
});

test("createAgentStreamState accumulates cost from usage events", () => {
  const state = createAgentStreamState();

  const event: ReactorEmittedEvent = {
    type: "inference.usage",
    seq: 1,
    data: {
      usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { id: "xai", model: "test" },
    } as unknown as ReactorEmittedEvent["data"],
  };

  state.addEvent(event);
  expect(state.totalCost).toBeGreaterThan(0);
  expect(state.totalTokens).toBe(1500);
});

test("createAgentStreamState tracks status from reactor.done", () => {
  const state = createAgentStreamState();

  const event: ReactorEmittedEvent = {
    type: "reactor.done",
    seq: 1,
    data: {} as unknown as ReactorEmittedEvent["data"],
  };

  state.addEvent(event);
  expect(state.status).toBe("done");
});

test("createAgentStreamState tracks status from inference.error", () => {
  const state = createAgentStreamState();

  const event: ReactorEmittedEvent = {
    type: "inference.error",
    seq: 1,
    data: {
      error: { category: "fatal", message: "test error" },
    } as unknown as ReactorEmittedEvent["data"],
  };

  state.addEvent(event);
  expect(state.status).toBe("failed");
});

test("a received user message updates latest user message and adds a log block", () => {
  const state = createAgentStreamState();
  state.addEvent({
    type: "message.received",
    seq: 1,
    data: { message: { content: "hello world" } } as unknown as ReactorEmittedEvent["data"],
  });
  expect(state.latestUserMessage).toBe("hello world");
  expect(state.contentBlocks.length).toBe(1);
  expect(state.contentBlocks[0].type).toBe("user");
  expect(state.contentBlocks[0].content).toBe("hello world");
});

test("createAgentStreamState accumulates thinking delta tokens", () => {
  const state = createAgentStreamState();

  state.addEvent({ type: "inference.thinking.delta", seq: 1, data: { token: "H" } as unknown as ReactorEmittedEvent["data"] });
  state.addEvent({ type: "inference.thinking.delta", seq: 2, data: { token: "i" } as unknown as ReactorEmittedEvent["data"] });

  expect(state.contentBlocks.length).toBe(1);
  expect(state.contentBlocks[0].type).toBe("thinking");
  expect(state.contentBlocks[0].content).toBe("Hi");
});

test("createAgentStreamState accumulates text delta tokens", () => {
  const state = createAgentStreamState();

  state.addEvent({ type: "inference.text.delta", seq: 1, data: { token: "Hello" } as unknown as ReactorEmittedEvent["data"] });

  expect(state.contentBlocks.length).toBe(1);
  expect(state.contentBlocks[0].type).toBe("text");
  expect(state.contentBlocks[0].content).toBe("Hello");
});

test("createAgentStreamState accumulates tool_call delta fragments", () => {
  const state = createAgentStreamState();

  state.addEvent({ type: "inference.tool_call.start", seq: 1, data: { name: "read_file", callId: "c1" } as unknown as ReactorEmittedEvent["data"] });
  state.addEvent({ type: "inference.tool_call.delta", seq: 2, data: { argumentFragment: '{"path":"a"}' } as unknown as ReactorEmittedEvent["data"] });

  expect(state.contentBlocks.length).toBe(1);
  expect(state.contentBlocks[0].type).toBe("tool_call");
  expect(state.contentBlocks[0].arguments).toBe('{"path":"a"}');
});

function submitPlanEvents(callId: string, steps: Array<{ file: string; action: string; reason?: string }>): ReactorEmittedEvent[] {
  return [
    {
      type: "inference.tool_call.start",
      seq: 1,
      data: { name: "submit_plan", callId } as unknown as ReactorEmittedEvent["data"],
    },
    {
      type: "inference.tool_call.delta",
      seq: 2,
      data: { argumentFragment: JSON.stringify({ steps }) } as unknown as ReactorEmittedEvent["data"],
    },
    {
      type: "tool.done",
      seq: 3,
      data: { result: { callId, content: "ok", isError: false } } as unknown as ReactorEmittedEvent["data"],
    },
  ];
}

test("submit_plan promotes to pinned plan block at index 0", () => {
  const state = createAgentStreamState();
  for (const e of submitPlanEvents("plan-1", [
    { file: "src/a.ts", action: "create", reason: "x" },
    { file: "src/b.ts", action: "edit", reason: "y" },
  ])) {
    state.addEvent(e);
  }

  expect(state.contentBlocks.length).toBe(1);
  expect(state.contentBlocks[0].type).toBe("plan");
  const plan = state.contentBlocks[0] as { type: "plan"; steps: Array<{ file: string; action: string; reason: string }> };
  expect(plan.steps).toEqual([
    { file: "src/a.ts", action: "create", reason: "x" },
    { file: "src/b.ts", action: "edit", reason: "y" },
  ]);
});

test("submit_plan does not leave a tool_call or tool_result behind", () => {
  const state = createAgentStreamState();
  for (const e of submitPlanEvents("plan-1", [{ file: "f", action: "a" }])) {
    state.addEvent(e);
  }
  expect(state.contentBlocks.some((b) => b.type === "tool_call")).toBe(false);
  expect(state.contentBlocks.some((b) => b.type === "tool_result")).toBe(false);
});

test("plan stays pinned at index 0 as new events arrive", () => {
  const state = createAgentStreamState();
  for (const e of submitPlanEvents("plan-1", [{ file: "f", action: "a" }])) {
    state.addEvent(e);
  }

  state.addEvent({
    type: "message.received",
    seq: 9,
    data: { message: { content: "now do it" } } as unknown as ReactorEmittedEvent["data"],
  });
  state.addEvent({
    type: "inference.tool_call.start",
    seq: 10,
    data: { name: "read_file", callId: "c2" } as unknown as ReactorEmittedEvent["data"],
  });
  state.addEvent({
    type: "tool.done",
    seq: 11,
    data: { result: { callId: "c2", content: "file body", isError: false } } as unknown as ReactorEmittedEvent["data"],
  });

  expect(state.contentBlocks[0].type).toBe("plan");
  expect(state.contentBlocks.filter((b) => b.type === "plan").length).toBe(1);
  expect(state.contentBlocks.length).toBeGreaterThan(1);
});

test("submit_plan with invalid arguments yields an empty plan block (no crash)", () => {
  const state = createAgentStreamState();
  state.addEvent({
    type: "inference.tool_call.start",
    seq: 1,
    data: { name: "submit_plan", callId: "p1" } as unknown as ReactorEmittedEvent["data"],
  });
  state.addEvent({
    type: "inference.tool_call.delta",
    seq: 2,
    data: { argumentFragment: "{not-json" } as unknown as ReactorEmittedEvent["data"],
  });
  state.addEvent({
    type: "tool.done",
    seq: 3,
    data: { result: { callId: "p1", content: "ok", isError: false } } as unknown as ReactorEmittedEvent["data"],
  });

  expect(state.contentBlocks[0].type).toBe("plan");
  expect((state.contentBlocks[0] as { steps: unknown[] }).steps).toEqual([]);
});

test("failed submit_plan does not create a plan block", () => {
  const state = createAgentStreamState();
  state.addEvent({
    type: "inference.tool_call.start",
    seq: 1,
    data: { name: "submit_plan", callId: "p1" } as unknown as ReactorEmittedEvent["data"],
  });
  state.addEvent({
    type: "tool.done",
    seq: 2,
    data: { result: { callId: "p1", content: "bad", isError: true } } as unknown as ReactorEmittedEvent["data"],
  });

  expect(state.contentBlocks.some((b) => b.type === "plan")).toBe(false);
});

test("createAgentStreamState tracks hook load and update events", () => {
  const state = createAgentStreamState();
  state.addHookEvent({
    type: "hooks.loaded",
    hooks: [
      {
        id: "hook-1",
        name: "one.ts",
        type: "typescript",
        path: "/tmp/one.ts",
        enabled: true,
      },
    ],
  });
  expect(state.hooks.length).toBe(1);
  expect(state.hooks[0]?.enabled).toBe(true);

  state.addHookEvent({
    type: "hook.updated",
    hook: {
      id: "hook-1",
      name: "one.ts",
      type: "typescript",
      path: "/tmp/one.ts",
      enabled: false,
      lastExitStatus: { code: 0, signal: null, stderr: "" },
    },
  });

  expect(state.hooks[0]?.enabled).toBe(false);
  expect(state.hooks[0]?.lastExitStatus?.code).toBe(0);
});

function toolCallEvents(name: string, callId: string, args: object): ReactorEmittedEvent[] {
  return [
    { type: "inference.tool_call.start", seq: 1, data: { name, callId } as unknown as ReactorEmittedEvent["data"] },
    { type: "inference.tool_call.delta", seq: 2, data: { argumentFragment: JSON.stringify(args) } as unknown as ReactorEmittedEvent["data"] },
    { type: "tool.done", seq: 3, data: { result: { callId, content: "ok", isError: false } } as unknown as ReactorEmittedEvent["data"] },
  ];
}

test("structured tool result content is normalized to a string", () => {
  const state = createAgentStreamState();
  state.addEvent({
    type: "inference.tool_call.start",
    seq: 1,
    data: { name: "web_search", callId: "web-1" } as unknown as ReactorEmittedEvent["data"],
  });
  state.addEvent({
    type: "tool.done",
    seq: 2,
    data: {
      result: {
        callId: "web-1",
        content: {
          results: [{ title: "Hono", url: "https://hono.dev", snippet: "Fast web framework" }],
        },
        isError: false,
      },
    } as unknown as ReactorEmittedEvent["data"],
  });

  const result = state.contentBlocks.at(-1);
  expect(result?.type).toBe("tool_result");
  if (result?.type !== "tool_result") return;
  expect(result.content).toContain('"results"');
  expect(result.content).toContain("https://hono.dev");
});

test("submit_plan seeds plan totals and current step", () => {
  const state = createAgentStreamState();
  for (const e of submitPlanEvents("p1", [
    { file: "src/a.ts", action: "create" },
    { file: "src/b.ts", action: "edit" },
  ])) {
    state.addEvent(e);
  }
  expect(state.planTotal).toBe(2);
  expect(state.currentPlanStep).toBe(0);
  expect(state.planDeviated).toBe(false);
});

test("write_file on the matching step advances the current plan step", () => {
  const state = createAgentStreamState();
  for (const e of submitPlanEvents("p1", [
    { file: "src/a.ts", action: "create" },
    { file: "src/b.ts", action: "edit" },
  ])) {
    state.addEvent(e);
  }
  for (const e of toolCallEvents("write_file", "w1", { path: "src/a.ts" })) {
    state.addEvent(e);
  }
  expect(state.currentPlanStep).toBe(1);
  expect(state.planDeviated).toBe(false);
});

test("edit_file on a non-matching file sets planDeviated", () => {
  const state = createAgentStreamState();
  for (const e of submitPlanEvents("p1", [{ file: "src/a.ts", action: "create" }])) {
    state.addEvent(e);
  }
  for (const e of toolCallEvents("edit_file", "w1", { path: "src/elsewhere.ts" })) {
    state.addEvent(e);
  }
  expect(state.planDeviated).toBe(true);
  expect(state.currentPlanStep).toBe(0);
});

test("a failed write does not advance the plan step", () => {
  const state = createAgentStreamState();
  for (const e of submitPlanEvents("p1", [{ file: "src/a.ts", action: "create" }, { file: "src/b.ts", action: "edit" }])) {
    state.addEvent(e);
  }
  state.addEvent({ type: "inference.tool_call.start", seq: 1, data: { name: "write_file", callId: "w1" } as unknown as ReactorEmittedEvent["data"] });
  state.addEvent({ type: "inference.tool_call.delta", seq: 2, data: { argumentFragment: JSON.stringify({ path: "src/a.ts" }) } as unknown as ReactorEmittedEvent["data"] });
  state.addEvent({ type: "tool.done", seq: 3, data: { result: { callId: "w1", content: "denied", isError: true } } as unknown as ReactorEmittedEvent["data"] });
  expect(state.currentPlanStep).toBe(0);
  expect(state.planDeviated).toBe(false);
});

test("setGatePending toggles between running and blocked", () => {
  const state = createAgentStreamState();
  state.markRunning();
  expect(state.status).toBe("running");
  state.setGatePending(true);
  expect(state.status).toBe("blocked");
  state.setGatePending(false);
  expect(state.status).toBe("running");
});

test("setGatePending does not override a terminal done status", () => {
  const state = createAgentStreamState();
  state.addEvent({ type: "reactor.done", seq: 1, data: {} as unknown as ReactorEmittedEvent["data"] });
  state.setGatePending(true);
  expect(state.status).toBe("done");
});

test("awaitingResponse arms on send and clears on the first streamed token", () => {
  const state = createAgentStreamState();
  expect(state.awaitingResponse).toBe(false);

  state.markRunning();
  expect(state.awaitingResponse).toBe(true);

  state.addEvent({ type: "inference.text.delta", seq: 1, data: { token: "H" } as unknown as ReactorEmittedEvent["data"] });
  expect(state.awaitingResponse).toBe(false);
});

test("awaitingResponse re-arms after a tool result until the next token", () => {
  const state = createAgentStreamState();
  for (const e of toolCallEvents("read_file", "c1", { path: "a.ts" })) state.addEvent(e);
  // tool.done was the last event — the model is now thinking again.
  expect(state.awaitingResponse).toBe(true);

  state.addEvent({ type: "inference.text.delta", seq: 9, data: { token: "x" } as unknown as ReactorEmittedEvent["data"] });
  expect(state.awaitingResponse).toBe(false);
});

test("awaitingResponse clears when inference completes without streamed tokens", () => {
  const state = createAgentStreamState();
  for (const e of toolCallEvents("read_file", "c1", { path: "a.ts" })) state.addEvent(e);
  expect(state.awaitingResponse).toBe(true);

  state.addEvent({
    type: "inference.done",
    seq: 9,
    data: {
      turn: { role: "assistant", model: "test", timestamp: 0, content: [] },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { id: "test", model: "test" },
    } as unknown as ReactorEmittedEvent["data"],
  });

  expect(state.awaitingResponse).toBe(false);
});

test("awaitingResponse clears when the run completes", () => {
  const state = createAgentStreamState();
  state.markRunning();
  state.addEvent({ type: "reactor.done", seq: 1, data: {} as unknown as ReactorEmittedEvent["data"] });
  expect(state.awaitingResponse).toBe(false);
});

test("elapsedMs freezes after the run completes", async () => {
  const state = createAgentStreamState();
  state.addEvent({ type: "reactor.done", seq: 1, data: {} as unknown as ReactorEmittedEvent["data"] });
  const first = state.elapsedMs;
  await new Promise((r) => setTimeout(r, 5));
  expect(state.elapsedMs).toBe(first);
});

// D3: contentBlocks getter must return the same array reference on consecutive reads
// within a single render cycle (no intervening mutations).
test("D3: contentBlocks returns the same reference when nothing changed", () => {
  const state = createAgentStreamState();
  state.addEvent({
    type: "inference.text.delta",
    seq: 1,
    data: { token: "hello" } as unknown as ReactorEmittedEvent["data"],
  });
  const a = state.contentBlocks;
  const b = state.contentBlocks;
  expect(a).toBe(b);
});

// D3: A structural change (a new block) must return a new reference so
// consumers relying on identity for change detection see it.
//
// A follow-up streamed token delta into an *existing* block used to also
// return a new reference here — the getter re-copied the whole contentBlocks
// array on every token. That made steady-state streaming layout cost grow
// with transcript length instead of staying O(1): a token delta
// mutates the trailing block's content in place, so the array's shape and
// object identities are unchanged and no new snapshot is needed. React
// re-rendering on a token delta does not depend on this reference changing —
// useAgentStream forces a re-render via its own tick/displayRevision state,
// not via contentBlocks identity. See the "reuse the contentBlocks snapshot
// reference" test below for the corrected invariant.
test("D3: contentBlocks returns a new reference after a structural change", () => {
  const state = createAgentStreamState();
  state.addEvent({
    type: "inference.text.delta",
    seq: 1,
    data: { token: "hello" } as unknown as ReactorEmittedEvent["data"],
  });
  const before = state.contentBlocks;
  state.addEvent({
    type: "inference.tool_call.start",
    seq: 2,
    data: { name: "read_file", callId: "c1" } as unknown as ReactorEmittedEvent["data"],
  });
  const after = state.contentBlocks;
  expect(after).not.toBe(before);
});

// E1: resolving one gate while another is still open must NOT flip status back to "running".
test("E1: status stays blocked when two gates open and only one resolves", () => {
  const state = createAgentStreamState();
  state.markRunning();
  state.setGatePending(true);
  state.setGatePending(true);
  state.setGatePending(false);
  expect(state.status).toBe("blocked");
});

// E1: status returns to running only when the last gate resolves.
test("E1: status returns to running when all gates resolve", () => {
  const state = createAgentStreamState();
  state.markRunning();
  state.setGatePending(true);
  state.setGatePending(true);
  state.setGatePending(false);
  state.setGatePending(false);
  expect(state.status).toBe("running");
});

// H3: a successful present must splice out the originating tool_call block.
test("H3: present success removes the tool_call block from the log", () => {
  const state = createAgentStreamState();
  // validateView expects { type: "text", text: "..." }
  const view = { type: "text", text: "hi" };
  state.addEvent({
    type: "inference.tool_call.start",
    seq: 1,
    data: { name: "present", callId: "p1" } as unknown as ReactorEmittedEvent["data"],
  });
  state.addEvent({
    type: "inference.tool_call.delta",
    seq: 2,
    data: { argumentFragment: JSON.stringify({ view }) } as unknown as ReactorEmittedEvent["data"],
  });
  state.addEvent({
    type: "tool.done",
    seq: 3,
    data: { result: { callId: "p1", content: "ok", isError: false } } as unknown as ReactorEmittedEvent["data"],
  });
  const blocks = state.contentBlocks;
  expect(blocks.some((b) => b.type === "tool_call" && b.name === "present")).toBe(false);
  expect(blocks.some((b) => b.type === "view")).toBe(true);
});

// H4: callIdToName and callIdToArguments must not retain entries after tool.done is processed.
// We verify this indirectly: after a tool.done for a given callId, a *second* tool.done
// with the same callId (e.g. replayed or duplicated) must not find stale map entries.
// The observable effect is that the second event falls through to a plain tool_result
// rather than triggering special logic (no second plan block, no second view block).
test("H4: stale map entries are cleaned up after tool.done for submit_plan", () => {
  const state = createAgentStreamState();
  for (const e of submitPlanEvents("p1", [{ file: "a.ts", action: "create" }])) {
    state.addEvent(e);
  }
  // Replay the same tool.done — should not create a second plan block.
  state.addEvent({
    type: "tool.done",
    seq: 99,
    data: { result: { callId: "p1", content: "ok", isError: false } } as unknown as ReactorEmittedEvent["data"],
  });
  expect(state.contentBlocks.filter((b) => b.type === "plan").length).toBe(1);
});

// ---------------------------------------------------------------------------
// inference.error category mapping
// ---------------------------------------------------------------------------

function inferenceErrorEvent(category: string, message: string): ReactorEmittedEvent {
  return {
    type: "inference.error",
    seq: 1,
    data: { error: { category, message } } as unknown as ReactorEmittedEvent["data"],
  };
}

test("inference.error credential_failure maps to friendly message and sets status failed", () => {
  const state = createAgentStreamState();
  state.addEvent(inferenceErrorEvent("credential_failure", "raw"));
  expect(state.status).toBe("failed");
  const last = state.contentBlocks.at(-1);
  expect(last?.type).toBe("error");
  if (last?.type !== "error") return;
  expect(last.message).toBe("Session expired — re-authenticating…");
});

test("inference.error quota_exhausted maps to friendly message", () => {
  const state = createAgentStreamState();
  state.addEvent(inferenceErrorEvent("quota_exhausted", "raw"));
  const last = state.contentBlocks.at(-1);
  if (last?.type !== "error") throw new Error("expected error block");
  expect(last.message).toBe("Quota exhausted — usage limit reached.");
});

test("inference.error context_overflow maps to friendly message", () => {
  const state = createAgentStreamState();
  state.addEvent(inferenceErrorEvent("context_overflow", "raw"));
  const last = state.contentBlocks.at(-1);
  if (last?.type !== "error") throw new Error("expected error block");
  expect(last.message).toBe("Context window full — compaction could not keep up. Try /clear to start fresh.");
});

test("a quota_exhausted error whose message describes a context overflow is reclassified", () => {
  const state = createAgentStreamState();
  state.addEvent(inferenceErrorEvent("quota_exhausted", "This model's maximum context length is 32768 tokens"));
  const last = state.contentBlocks.at(-1);
  if (last?.type !== "error") throw new Error("expected error block");
  expect(last.message).toContain("Context window full");
});

test.each(["retryable", "timeout"])(
  "inference.error %s stays live without rendering recovery noise",
  (category) => {
    const state = createAgentStreamState();
    state.addEvent(inferenceErrorEvent(category, "raw"));
    expect(state.status).not.toBe("failed");
    expect(state.contentBlocks.some((block) => block.type === "error")).toBe(false);
  },
);

test("inference.error internal-recovery aborted stays live without rendering recovery noise", () => {
  const state = createAgentStreamState();
  state.addEvent({
    type: "inference.error",
    data: {
      error: { category: "aborted", message: "raw", raw: { origin: INFERENCE_ABORT_INTERNAL_RECOVERY } },
    },
  } as ReactorEmittedEvent);
  expect(state.status).not.toBe("failed");
  expect(state.contentBlocks.some((block) => block.type === "error")).toBe(false);
});

test("inference.error protocol_mismatch maps to friendly message", () => {
  const state = createAgentStreamState();
  state.addEvent(inferenceErrorEvent("protocol_mismatch", "raw"));
  const last = state.contentBlocks.at(-1);
  if (last?.type !== "error") throw new Error("expected error block");
  expect(last.message).toBe("Unexpected response from inference API.");
});

test("inference.error unknown category falls back to raw message", () => {
  const state = createAgentStreamState();
  state.addEvent(inferenceErrorEvent("some_new_category", "the upstream detail"));
  expect(state.status).toBe("failed");
  const last = state.contentBlocks.at(-1);
  if (last?.type !== "error") throw new Error("expected error block");
  // Falls back to err.message so callers see the original detail instead of undefined.
  expect(last.message).toBe("the upstream detail");
});

// ---------------------------------------------------------------------------
// reactor.error
// ---------------------------------------------------------------------------

test("reactor.error pushes an error block and sets status to failed", () => {
  const state = createAgentStreamState();
  state.addEvent({
    type: "reactor.error",
    seq: 1,
    data: { fatal: true, error: "disk full" } as unknown as ReactorEmittedEvent["data"],
  });
  expect(state.status).toBe("failed");
  const last = state.contentBlocks.at(-1);
  expect(last?.type).toBe("error");
  if (last?.type !== "error") return;
  expect(last.message).toBe("disk full");
});

// ---------------------------------------------------------------------------
// Orphaned inference.tool_call.delta (no preceding start, openCallId null)
// ---------------------------------------------------------------------------

test("orphaned tool_call.delta with no preceding start does not crash and is dropped", () => {
  const state = createAgentStreamState();
  // No tool_call.start has fired — openCallId is null and contentBlocks is empty.
  expect(() => {
    state.addEvent({
      type: "inference.tool_call.delta",
      seq: 1,
      data: { argumentFragment: '{"path":"x"}' } as unknown as ReactorEmittedEvent["data"],
    });
  }).not.toThrow();
  // Fragment must be silently dropped — no block should have been created.
  expect(state.contentBlocks.length).toBe(0);
});

test("orphaned tool_call.delta after a text block does not corrupt the text block", () => {
  const state = createAgentStreamState();
  state.addEvent({
    type: "inference.text.delta",
    seq: 1,
    data: { token: "hello" } as unknown as ReactorEmittedEvent["data"],
  });
  // openCallId is still null here — no start was ever fired.
  state.addEvent({
    type: "inference.tool_call.delta",
    seq: 2,
    data: { argumentFragment: "CORRUPT" } as unknown as ReactorEmittedEvent["data"],
  });
  // The text block must be unchanged; the fragment must not have been appended.
  expect(state.contentBlocks.length).toBe(1);
  const block = state.contentBlocks[0];
  if (block?.type !== "text") throw new Error("expected text block");
  expect(block.content).toBe("hello");
});

// ---------------------------------------------------------------------------
// connector.reply DROP path
// ---------------------------------------------------------------------------

test("connector.reply is dropped when text deltas already arrived this cycle", () => {
  const state = createAgentStreamState();
  state.addEvent({
    type: "inference.text.delta",
    seq: 1,
    data: { token: "streamed" } as unknown as ReactorEmittedEvent["data"],
  });
  // connector.reply fired after deltas — must not append duplicate content.
  state.addEvent({
    type: "connector.reply",
    seq: 2,
    data: { content: "streamed" } as unknown as ReactorEmittedEvent["data"],
  });
  // Still exactly one text block with only the streamed token.
  const textBlocks = state.contentBlocks.filter((b) => b.type === "text");
  expect(textBlocks.length).toBe(1);
  if (textBlocks[0]?.type !== "text") return;
  expect(textBlocks[0].content).toBe("streamed");
});

test("connector.reply is pushed when no text deltas arrived since the last reply", () => {
  const state = createAgentStreamState();
  // No inference.text.delta fired — director-generated reply must be rendered.
  state.addEvent({
    type: "connector.reply",
    seq: 1,
    data: { content: "director reply" } as unknown as ReactorEmittedEvent["data"],
  });
  const textBlocks = state.contentBlocks.filter((b) => b.type === "text");
  expect(textBlocks.length).toBe(1);
  if (textBlocks[0]?.type !== "text") return;
  expect(textBlocks[0].content).toBe("director reply");
});

test("connector.reply resets the delta flag so a subsequent reply is not dropped", () => {
  const state = createAgentStreamState();
  // First cycle: delta then reply (dropped).
  state.addEvent({
    type: "inference.text.delta",
    seq: 1,
    data: { token: "first" } as unknown as ReactorEmittedEvent["data"],
  });
  state.addEvent({
    type: "connector.reply",
    seq: 2,
    data: { content: "first" } as unknown as ReactorEmittedEvent["data"],
  });
  // Second cycle: no delta before next reply — must NOT be dropped.
  state.addEvent({
    type: "connector.reply",
    seq: 3,
    data: { content: "second director" } as unknown as ReactorEmittedEvent["data"],
  });
  // The second reply content must appear.
  const textBlocks = state.contentBlocks.filter((b) => b.type === "text");
  const combined = textBlocks.map((b) => (b.type === "text" ? b.content : "")).join("");
  expect(combined).toContain("second director");
});

// ---------------------------------------------------------------------------
// Duplicate inference.tool_call.start with the same callId
// ---------------------------------------------------------------------------

test("duplicate tool_call.start with the same callId does not corrupt a different in-flight call", () => {
  const state = createAgentStreamState();
  // Start call A.
  state.addEvent({
    type: "inference.tool_call.start",
    seq: 1,
    data: { name: "read_file", callId: "a1" } as unknown as ReactorEmittedEvent["data"],
  });
  state.addEvent({
    type: "inference.tool_call.delta",
    seq: 2,
    data: { argumentFragment: '{"path":"keep"}' } as unknown as ReactorEmittedEvent["data"],
  });
  // Spurious duplicate start for the same callId — must not corrupt call A's arg accumulator
  // by overwriting it with an empty string while a different tool is running concurrently.
  // After the duplicate start the openCallId is now "a1" again; a delta goes to a1.
  state.addEvent({
    type: "inference.tool_call.start",
    seq: 3,
    data: { name: "read_file", callId: "a1" } as unknown as ReactorEmittedEvent["data"],
  });
  state.addEvent({
    type: "tool.done",
    seq: 4,
    data: { result: { callId: "a1", content: "ok", isError: false } } as unknown as ReactorEmittedEvent["data"],
  });
  // The tool_result block must use the tracked name, not fall back to callId.
  const resultBlock = state.contentBlocks.find((b) => b.type === "tool_result");
  expect(resultBlock?.type).toBe("tool_result");
  if (resultBlock?.type !== "tool_result") return;
  expect(resultBlock.name).toBe("read_file");
});

test("duplicate tool_call.start resets arg accumulator for that callId", () => {
  const state = createAgentStreamState();
  state.addEvent({
    type: "inference.tool_call.start",
    seq: 1,
    data: { name: "write_file", callId: "w1" } as unknown as ReactorEmittedEvent["data"],
  });
  state.addEvent({
    type: "inference.tool_call.delta",
    seq: 2,
    data: { argumentFragment: '{"path":"original.ts"}' } as unknown as ReactorEmittedEvent["data"],
  });
  // Duplicate start clears the arg accumulator to "".
  state.addEvent({
    type: "inference.tool_call.start",
    seq: 3,
    data: { name: "write_file", callId: "w1" } as unknown as ReactorEmittedEvent["data"],
  });
  // Only the post-reset fragment arrives.
  state.addEvent({
    type: "inference.tool_call.delta",
    seq: 4,
    data: { argumentFragment: '{"path":"reset.ts"}' } as unknown as ReactorEmittedEvent["data"],
  });
  // Two tool_call blocks were pushed (one per start). The last one is the active one.
  const toolCallBlocks = state.contentBlocks.filter((b) => b.type === "tool_call");
  // We verify the last block's arguments only contain the post-reset fragment.
  const lastToolCall = toolCallBlocks.at(-1);
  if (lastToolCall?.type !== "tool_call") throw new Error("expected tool_call block");
  expect(lastToolCall.arguments).toBe('{"path":"reset.ts"}');
});

// ---------------------------------------------------------------------------
// nextFileStepIndex — fileless step skipping and plan deviation
// ---------------------------------------------------------------------------

test("write_file during a fileless step skips to the next file step and does not deviate", () => {
  const state = createAgentStreamState();
  // Step 0 has no file (investigate), step 1 has foo.ts.
  for (const e of submitPlanEvents("p1", [
    { file: "", action: "investigate" },
    { file: "foo.ts", action: "edit" },
  ])) {
    state.addEvent(e);
  }
  // currentPlanStep is 0 (the investigate step). A write to foo.ts should
  // skip step 0 (fileless) and match step 1, advancing the pointer past it.
  for (const e of toolCallEvents("write_file", "w1", { path: "foo.ts" })) {
    state.addEvent(e);
  }
  // Step 1 was the last file step; after advancing, currentPlanStep is null.
  expect(state.planDeviated).toBe(false);
  expect(state.currentPlanStep).toBeNull();
});

test("write_file to a different file while on a fileless step sets planDeviated", () => {
  const state = createAgentStreamState();
  for (const e of submitPlanEvents("p1", [
    { file: "", action: "investigate" },
    { file: "foo.ts", action: "edit" },
  ])) {
    state.addEvent(e);
  }
  // Write to a file that does not match the next file step.
  for (const e of toolCallEvents("write_file", "w1", { path: "bar.ts" })) {
    state.addEvent(e);
  }
  expect(state.planDeviated).toBe(true);
  // currentPlanStep stays at 0 — did not advance.
  expect(state.currentPlanStep).toBe(0);
});

test("gate count does not stick after an abort while a gate is open", () => {
  const state = createAgentStreamState();
  state.markRunning();
  state.setGatePending(true);
  expect(state.status).toBe("blocked");
  // Abort the run while the gate is still open, then the gate resolves late.
  state.requestStop();
  expect(state.status).toBe("stopped");
  state.setGatePending(false);
  // A fresh run must not inherit a stuck gate count and start wedged.
  state.markRunning();
  expect(state.status).toBe("running");
  state.setGatePending(true);
  expect(state.status).toBe("blocked");
  state.setGatePending(false);
  expect(state.status).toBe("running");
});

test("a block keeps its stable id across a submit_plan splice that shifts indices", () => {
  const state = createAgentStreamState();
  state.addEvent({
    type: "inference.tool_call.start",
    seq: 1,
    data: { name: "read_file", callId: "c1" } as unknown as ReactorEmittedEvent["data"],
  });
  const before = state.contentBlocks;
  const tracked = before.find((b) => b.type === "tool_call");
  expect(tracked).toBeDefined();
  const trackedId = tracked!.id;
  const indexBefore = before.findIndex((b) => b.id === trackedId);

  // submit_plan splices its own tool_call out and unshifts a plan block, which
  // renumbers array positions — index-keyed expansion state would now point at
  // the wrong block; id-keyed state must stay anchored to the same block.
  for (const e of submitPlanEvents("plan-1", [{ file: "f", action: "a" }])) {
    state.addEvent(e);
  }

  const after = state.contentBlocks;
  const stillThere = after.find((b) => b.id === trackedId);
  expect(stillThere).toBeDefined();
  expect(stillThere!.type).toBe("tool_call");
  const indexAfter = after.findIndex((b) => b.id === trackedId);
  expect(indexAfter).not.toBe(indexBefore);
});

test("activityTick increments on thinking, text, and tool_call deltas", () => {
  const state = createAgentStreamState();
  expect(state.activityTick).toBe(0);

  state.addEvent({ type: "inference.thinking.delta", seq: 1, data: { token: "a" } } as unknown as ReactorEmittedEvent);
  expect(state.activityTick).toBe(1);

  state.addEvent({ type: "inference.text.delta", seq: 2, data: { token: "b" } } as unknown as ReactorEmittedEvent);
  expect(state.activityTick).toBe(2);

  state.addEvent({ type: "inference.tool_call.start", seq: 3, data: { name: "read_file", callId: "c1" } } as unknown as ReactorEmittedEvent);
  state.addEvent({ type: "inference.tool_call.delta", seq: 4, data: { argumentFragment: "{" } } as unknown as ReactorEmittedEvent);
  expect(state.activityTick).toBe(3);

  state.clear();
  expect(state.activityTick).toBe(0);
});
