import { describe, expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";
import { AgentClosedError } from "@intx/agent";

import { createSubAgentSessionStore } from "./session-store.js";

const T0 = Date.parse("2026-10-09T12:00:00.000Z");

function store() {
  let clock = T0;
  const sessions = createSubAgentSessionStore({
    now: () => clock,
  });
  return {
    sessions,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function startRunning(
  sessions: ReturnType<typeof createSubAgentSessionStore>,
  id = "w1",
  opts: { retained?: boolean } = {},
): string {
  sessions.start({
    id,
    description: "worker",
    agentId: "explorer",
    brief: "b",
    ...(opts.retained === true ? { retained: true } : {}),
  });
  sessions.markRunInFlight(id);
  sessions.markRunning(id);
  return id;
}

function ask(
  sessions: ReturnType<typeof createSubAgentSessionStore>,
  id: string,
  opts: { reject?: (reason: unknown) => void } = {},
): Promise<string> {
  let resolveAnswer: (answer: string) => void = () => undefined;
  let rejectAnswer: (reason: unknown) => void = () => undefined;
  const answer = new Promise<string>((resolve, reject) => {
    resolveAnswer = resolve;
    rejectAnswer = reject;
  });
  expect(
    sessions.registerAsk(id, {
      question: "which path?",
      questionId: "ask-1",
      resolve: resolveAnswer,
      reject: opts.reject ?? rejectAnswer,
    }),
  ).toBe(true);
  return answer;
}

function toolStart(name: string, id: string): ReactorEmittedEvent {
  return {
    type: "tool.start",
    seq: 1,
    data: { call: { name, id, arguments: {} } },
  } as unknown as ReactorEmittedEvent;
}

function toolDone(
  callId: string,
  content: string,
  isError = false,
): ReactorEmittedEvent {
  return {
    type: "tool.done",
    seq: 2,
    data: { result: { callId, content, isError } },
  } as unknown as ReactorEmittedEvent;
}

describe("terminal failure record", () => {
  test("fail writes one frozen record before subscribers can observe the failure", () => {
    const { sessions, advance } = store();
    const id = startRunning(sessions);
    advance(1_500);
    const seenWithoutRecord: string[] = [];
    sessions.subscribe(() => {
      const snap = sessions.get(id);
      if (snap?.lifecycle.state === "failed" && snap.failure === undefined) {
        seenWithoutRecord.push(id);
      }
    });

    sessions.fail(id, "upstream overloaded", {
      failure_class: "provider_retryable",
    });

    expect(seenWithoutRecord).toEqual([]);
    const snap = sessions.get(id);
    expect(snap?.failure).toEqual({
      agent_id: id,
      failure_class: "provider_retryable",
      failed_at: new Date(T0 + 1_500).toISOString(),
      recovery: { available: true, reason: "eligible" },
      attempt: 1,
      handoff: "none",
      cleanup: "released",
    });
    expect(snap?.failure?.failed_at).toBe(
      new Date(snap?.finishedAt ?? 0).toISOString(),
    );
    expect(Object.isFrozen(snap?.failure)).toBe(true);
  });

  test("fail without a classification records error", () => {
    const { sessions } = store();
    const id = startRunning(sessions);
    sessions.fail(id, "boom");
    expect(sessions.get(id)?.failure?.failure_class).toBe("error");
    expect(sessions.get(id)?.failure?.recovery).toEqual({
      available: false,
      reason: "not_retryable",
    });
  });

  test("late fail, complete, and tool events after settlement change nothing", () => {
    const { sessions, advance } = store();
    const id = startRunning(sessions);
    sessions.fail(id, "first", { failure_class: "provider_retryable" });
    const record = sessions.get(id)?.failure;
    expect(record).toBeDefined();

    advance(10);
    sessions.fail(id, "second", { failure_class: "loop_guard" });
    sessions.complete(id, "late report");
    sessions.appendEvent(id, toolStart("ask_director", "c1"));
    sessions.appendEvent(id, toolDone("c1", "late answer"));
    sessions.cancel(id);

    const after = sessions.get(id);
    expect(after?.failure).toBe(record as NonNullable<typeof record>);
    expect(after?.lifecycle.state).toBe("failed");
    expect(after?.error).toBe("first");
  });

  test("a teardown failure reports partial cleanup", () => {
    const { sessions } = store();
    const id = startRunning(sessions);
    sessions.fail(id, "session close exceeded 10ms", {
      failure_class: "error",
      teardownFailed: true,
    });
    expect(sessions.get(id)?.failure?.cleanup).toBe("partial");
  });

  test("an ask release that throws reports partial cleanup", () => {
    const { sessions } = store();
    const id = startRunning(sessions);
    void ask(sessions, id, {
      reject: () => {
        throw new Error("reject hook exploded");
      },
    });
    sessions.fail(id, "boom", { failure_class: "error" });
    expect(sessions.get(id)?.failure?.cleanup).toBe("partial");
  });

  test("a failure on a follow-up turn is never recovery-eligible", async () => {
    const { sessions } = store();
    const id = startRunning(sessions, "w1", { retained: true });
    sessions.registerFollowup(id, () => new Promise<string>(() => undefined));
    sessions.complete(id, "first report");
    expect(sessions.resumeOne(id, "next").ok).toBe(true);
    sessions.fail(id, "timeout", { failure_class: "provider_retryable" });
    expect(sessions.get(id)?.failure?.failure_class).toBe("provider_retryable");
    expect(sessions.get(id)?.failure?.recovery).toEqual({
      available: false,
      reason: "not_retryable",
    });
  });

  test("a follow-up rejected because the agent closed records error, not interrupted", async () => {
    const { sessions } = store();
    const id = startRunning(sessions, "w1", { retained: true });
    sessions.registerFollowup(id, async () => {
      throw new AgentClosedError();
    });
    sessions.complete(id, "first report");
    expect(sessions.resumeOne(id, "next").ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const snap = sessions.get(id);
    expect(snap?.lifecycle.state).toBe("failed");
    expect(snap?.failure?.failure_class).toBe("error");
    expect(snap?.failure?.recovery.reason).toBe("not_retryable");
  });
});

describe("terminal record for forced stops", () => {
  test.each([
    ["stalled", "stalled"],
    ["deadline", "deadline"],
    ["incomplete-report", "incomplete_report"],
    ["cancelled", "cancelled"],
  ] as const)("a %s salvage completion records %s", (stopReason, expected) => {
    const { sessions } = store();
    const id = startRunning(sessions);
    sessions.complete(id, "salvage", { agentRetained: false, stopReason });
    expect(sessions.get(id)?.failure?.failure_class).toBe(expected);
    expect(sessions.get(id)?.failure?.recovery.available).toBe(false);
  });

  test("a clean completion has no record", () => {
    const { sessions } = store();
    const id = startRunning(sessions);
    sessions.complete(id, "done");
    expect(sessions.get(id)?.failure).toBeUndefined();
  });

  test("operator cancel records cancelled", () => {
    const { sessions } = store();
    const id = startRunning(sessions);
    expect(sessions.cancel(id)).toBe(true);
    expect(sessions.get(id)?.failure?.failure_class).toBe("cancelled");
  });

  test("an interrupted lane records interrupted and drops it when resumed", () => {
    const { sessions } = store();
    const id = startRunning(sessions, "w1", { retained: true });
    sessions.registerInterrupt(id, () => undefined);
    sessions.registerFollowup(id, () => new Promise<string>(() => undefined));
    expect(sessions.interruptOne(id).ok).toBe(true);
    sessions.attachReport(id, "salvage", { stopReason: "interrupted" });
    expect(sessions.get(id)?.failure?.failure_class).toBe("interrupted");

    expect(sessions.resumeOne(id, "carry on").ok).toBe(true);
    expect(sessions.get(id)?.lifecycle.state).toBe("running");
    expect(sessions.get(id)?.failure).toBeUndefined();
  });
});

describe("handoff state", () => {
  test("no ask in the final turn gives none", () => {
    const { sessions } = store();
    const id = startRunning(sessions);
    sessions.fail(id, "boom", { failure_class: "provider_retryable" });
    expect(sessions.get(id)?.failure?.handoff).toBe("none");
  });

  test("an ask still open at termination gives unavailable and is released", async () => {
    const { sessions } = store();
    const id = startRunning(sessions);
    const answer = ask(sessions, id);
    sessions.fail(id, "boom", { failure_class: "provider_retryable" });
    expect(sessions.get(id)?.failure?.handoff).toBe("unavailable");
    expect(sessions.hasPendingAsk(id)).toBe(false);
    expect(sessions.isRunInFlight(id)).toBe(false);
    await expect(answer).rejects.toThrow("session failed");
  });

  test("an answered ask the run never consumed gives submitted", () => {
    const { sessions } = store();
    const id = startRunning(sessions);
    sessions.appendEvent(id, toolStart("ask_director", "c1"));
    void ask(sessions, id);
    expect(sessions.sendInputOne(id, "use src/").ok).toBe(true);
    sessions.fail(id, "timeout", { failure_class: "provider_retryable" });
    expect(sessions.get(id)?.failure?.handoff).toBe("submitted");
  });

  test("resolveAsk without consumption also gives submitted", () => {
    const { sessions } = store();
    const id = startRunning(sessions);
    void ask(sessions, id);
    expect(sessions.resolveAsk(id, "use src/")).toBe(true);
    sessions.fail(id, "timeout", { failure_class: "provider_retryable" });
    expect(sessions.get(id)?.failure?.handoff).toBe("submitted");
  });

  test("delivered only once the answered ask_director call returns into the run", () => {
    const { sessions } = store();
    const id = startRunning(sessions);
    sessions.appendEvent(id, toolStart("ask_director", "c1"));
    sessions.appendEvent(id, toolStart("read_file", "c2"));
    void ask(sessions, id);
    expect(sessions.sendInputOne(id, "use src/").ok).toBe(true);
    // A different tool finishing is not evidence the answer was consumed.
    sessions.appendEvent(id, toolDone("c2", "file body"));
    sessions.appendEvent(id, toolDone("c1", "use src/"));
    sessions.fail(id, "timeout", { failure_class: "provider_retryable" });
    expect(sessions.get(id)?.failure?.handoff).toBe("delivered");
  });

  test("an errored ask_director result does not count as delivery", () => {
    const { sessions } = store();
    const id = startRunning(sessions);
    sessions.appendEvent(id, toolStart("ask_director", "c1"));
    void ask(sessions, id);
    expect(sessions.sendInputOne(id, "use src/").ok).toBe(true);
    sessions.appendEvent(id, toolDone("c1", "Error: lost", true));
    sessions.fail(id, "timeout", { failure_class: "provider_retryable" });
    expect(sessions.get(id)?.failure?.handoff).toBe("submitted");
  });

  test("an ask_director return without a submitted answer never claims delivery", () => {
    const { sessions } = store();
    const id = startRunning(sessions);
    sessions.appendEvent(id, toolStart("ask_director", "c1"));
    sessions.appendEvent(
      id,
      toolDone("c1", "Error: ask_director was cancelled."),
    );
    sessions.fail(id, "boom", { failure_class: "error" });
    expect(sessions.get(id)?.failure?.handoff).toBe("none");
  });

  test("a follow-up turn starts with a fresh handoff trace", () => {
    const { sessions } = store();
    const id = startRunning(sessions, "w1", { retained: true });
    sessions.registerFollowup(id, () => new Promise<string>(() => undefined));
    void ask(sessions, id);
    expect(sessions.sendInputOne(id, "answer").ok).toBe(true);
    sessions.complete(id, "first report");
    expect(sessions.resumeOne(id, "next").ok).toBe(true);
    sessions.fail(id, "boom", { failure_class: "error" });
    expect(sessions.get(id)?.failure?.handoff).toBe("none");
  });
});
