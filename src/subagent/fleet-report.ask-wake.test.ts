/**
 * Parent-wake for workers parked in ask_director: the pure emitter-side
 * diff. Bridge delivery (stash / coalesce / flush-once) lives in
 * tui/agent-ask-wake.test.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  createPendingAskWatch,
  observePendingAsks,
  pendingAskWakeText,
  type FleetLane,
} from "./fleet-report.js";

function lane(overrides: Partial<FleetLane> & { id: string }): FleetLane {
  return {
    description: overrides.id,
    status: "running",
    startedAt: 0,
    lastActivityAt: 0,
    currentToolName: null,
    currentToolPreview: null,
    currentToolStartedAt: null,
    ...overrides,
  };
}

interface FakeAsk {
  readonly question: string;
  readonly questionId: string;
}

function peekAskFrom(asks: ReadonlyMap<string, FakeAsk>) {
  return (id: string): FakeAsk | undefined => asks.get(id);
}

describe("observePendingAsks", () => {
  test("a parked top-level ask wakes once, naming the question", () => {
    const asks = new Map([["a1", { question: "Which port?", questionId: "q1" }]] as const);
    const first = observePendingAsks(
      createPendingAskWatch(),
      [lane({ id: "a1", agentId: "builder", description: "Build the thing" })],
      peekAskFrom(asks),
    );
    expect(first.wakes).toHaveLength(1);
    expect(first.wakes[0]).toMatchObject({
      sessionId: "a1",
      agentId: "builder",
      description: "Build the thing",
      question: "Which port?",
      questionId: "q1",
    });

    // Store notifies again for the same question: no extra wake.
    const repeat = observePendingAsks(
      first.watch,
      [lane({ id: "a1", agentId: "builder", description: "Build the thing" })],
      peekAskFrom(asks),
    );
    expect(repeat.wakes).toEqual([]);
  });

  test("a resolved ask drops from the watch; a re-ask with a new questionId wakes again", () => {
    const asks = new Map([["a1", { question: "A?", questionId: "q1" }]] as const);
    const first = observePendingAsks(
      createPendingAskWatch(),
      [lane({ id: "a1" })],
      peekAskFrom(asks),
    );
    expect(first.wakes).toHaveLength(1);

    const resolved = observePendingAsks(first.watch, [lane({ id: "a1" })], peekAskFrom(new Map()));
    expect(resolved.wakes).toEqual([]);

    const reask = new Map([["a1", { question: "B?", questionId: "q2" }]] as const);
    const again = observePendingAsks(resolved.watch, [lane({ id: "a1" })], peekAskFrom(reask));
    expect(again.wakes).toHaveLength(1);
    expect(again.wakes[0]?.questionId).toBe("q2");
  });

  test("nested-orchestrator asks never wake the root", () => {
    const asks = new Map([["child", { question: "Q?", questionId: "q1" }]] as const);
    const { wakes } = observePendingAsks(
      createPendingAskWatch(),
      [lane({ id: "child", parentSessionId: "orchestrator" })],
      peekAskFrom(asks),
    );
    expect(wakes).toEqual([]);
  });

  test("a lane that is not running does not wake", () => {
    const asks = new Map([["a1", { question: "Q?", questionId: "q1" }]] as const);
    const { wakes } = observePendingAsks(
      createPendingAskWatch(),
      [lane({ id: "a1", status: "done" })],
      peekAskFrom(asks),
    );
    expect(wakes).toEqual([]);
  });
});

describe("pendingAskWakeText", () => {
  test("names agent, description, question and question id, and routes to send_input", () => {
    const text = pendingAskWakeText({
      sessionId: "a1",
      agentId: "builder",
      description: "Build the thing",
      question: "Which port?",
      questionId: "q1",
    });
    expect(text).toContain("builder");
    expect(text).toContain("Build the thing");
    expect(text).toContain("Which port?");
    expect(text).toContain("q1");
    expect(text).toContain("send_input");
    // The worker raised it; the parent must not present it as operator-asked.
    expect(text.toLowerCase()).toContain("worker");
  });
});
