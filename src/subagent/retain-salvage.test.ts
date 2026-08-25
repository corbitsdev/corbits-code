import { describe, expect, test } from "bun:test";
import { createSubAgentSessionStore } from "./session-store.js";

describe("retained session lifecycle", () => {
  test("a salvaged (deadline/cancel) run lands resumable even though run.ts disposed its agent", () => {
    const store = createSubAgentSessionStore({ maxCompleted: 5 });
    const s = store.start({
      description: "worker",
      agentId: "builder",
      brief: "b",
      retained: true,
    });
    store.markRunning(s.id);
    // run.ts salvage path RETURNS a report (does not throw) with stopReason
    // "deadline", but leaves turnSucceeded=false so finally disposes the
    // agent. agent-fleet's .then() still routes it to complete() — passing
    // agentRetained:false, exactly as its real call site does whenever
    // result.agentRetained isn't true.
    store.complete(s.id, "Stopped: deadline\n\nPartial work...", { agentRetained: false });
    const after = store.get(s.id);
    console.log("lifecycleStatus:", after?.lifecycleStatus, "retained:", after?.retained);
    const outcome = store.resumeOne(s.id);
    console.log("resumeOne outcome:", JSON.stringify(outcome));
    expect(outcome.ok).toBe(false);
  });

  test("cancelAll does not close retained completed sessions", () => {
    const store = createSubAgentSessionStore({ maxCompleted: 5 });
    const s = store.start({
      description: "worker",
      agentId: "builder",
      brief: "b",
      retained: true,
    });
    let closed = false;
    store.registerClose(s.id, async () => {
      closed = true;
    });
    store.complete(s.id, "done");
    const cancelled = store.cancelAll("parent stop");
    console.log("cancelAll returned:", cancelled, "| close invoked:", closed);
    expect(closed).toBe(true);
  });

  // CL-7007: retained completed sessions are no longer bounded by
  // `maxCompleted` (the TUI display cap) at all — that was CL-7002's fix,
  // and it created a new bug: resume_agent/followup_task started failing
  // with a bare "not_found" once more than `maxCompleted` (default 20)
  // workers had spawned in a turn, even though every one of them was still
  // perfectly reusable. Open retained sessions now get their own explicit
  // cap, `maxRetained`, sized for fan-out rather than a sidebar list — this
  // test moved from asserting `maxCompleted` bounds them to asserting
  // `maxRetained` does (still bounded, still no leak, just the right knob).
  test("retained completed sessions are bounded by maxRetained, not the display cap", () => {
    const store = createSubAgentSessionStore({ maxCompleted: 3, maxRetained: 3 });
    for (let i = 0; i < 50; i++) {
      const s = store.start({
        description: `w${i}`,
        agentId: "builder",
        brief: "b",
        retained: true,
      });
      store.registerClose(s.id, async () => {});
      store.complete(s.id, "done");
    }
    console.log("sessions retained despite maxRetained=3:", store.list().length);
    expect(store.list().length).toBeLessThanOrEqual(3);
  });

  test("a genuinely retained clean completion IS resumable, and cancelAll releases it", () => {
    const store = createSubAgentSessionStore({ maxCompleted: 5 });
    const s = store.start({
      description: "worker",
      agentId: "builder",
      brief: "b",
      retained: true,
    });
    store.markRunning(s.id);
    let closed = false;
    store.registerClose(s.id, async () => {
      closed = true;
    });
    // Mirrors agent-fleet's real call: only a clean turnSucceeded completion
    // sets agentRetained.
    store.complete(s.id, "done", { agentRetained: true });
    expect(store.resumeOne(s.id).ok).toBe(true);
    expect(closed).toBe(false);
    store.cancelAll("parent stop");
    expect(closed).toBe(true);
  });

  test("clear() releases every retained session's close handle instead of dropping it silently", () => {
    const store = createSubAgentSessionStore({ maxCompleted: 5 });
    const s = store.start({
      description: "worker",
      agentId: "builder",
      brief: "b",
      retained: true,
    });
    store.markRunning(s.id);
    let closed = false;
    store.registerClose(s.id, async () => {
      closed = true;
    });
    store.complete(s.id, "done", { agentRetained: true });
    store.clear();
    expect(closed).toBe(true);
  });

  test("close_agent during the setup window waits for the handle instead of falsely reporting shutdown", async () => {
    const store = createSubAgentSessionStore({ maxCompleted: 5 });
    const s = store.start({
      description: "worker",
      agentId: "builder",
      brief: "b",
      retained: true,
    });
    // No registerClose yet — closeOne races the agent-setup window.
    const closePromise = store.closeOne(s.id, 200);
    let registeredClose = false;
    setTimeout(() => {
      store.registerClose(s.id, async () => {
        registeredClose = true;
      });
    }, 20);
    const status = await closePromise;
    expect(status).toBe("shutdown");
    expect(registeredClose).toBe(true);
  });

  test("close_agent gives up honestly (not a false shutdown) if the handle never arrives in time", async () => {
    const store = createSubAgentSessionStore({ maxCompleted: 5 });
    const s = store.start({
      description: "worker",
      agentId: "builder",
      brief: "b",
      retained: true,
    });
    store.markRunning(s.id);
    const status = await store.closeOne(s.id, 30);
    expect(status).not.toBe("shutdown");
    expect(store.get(s.id)).toBeDefined();
  });
});
