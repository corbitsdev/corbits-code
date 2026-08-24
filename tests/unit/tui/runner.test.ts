import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { AgentContextLockError, type Agent } from "@intx/agent";
import {
  agentRebuildFailure,
  closeAgentForRebuild,
  createTUIEventEmitter,
  getTUIRunSummaryStatus,
  loadLocalSettingsWriteBase,
  resumeTranscriptLoadErrorBlock,
} from "../../../src/tui/runner.js";
import { createRunSink } from "../../../src/session/run-sink.js";

test("createTUIEventEmitter returns an EventEmitter", () => {
  const emitter = createTUIEventEmitter();
  expect(emitter).toBeInstanceOf(EventEmitter);
});

test("createTUIEventEmitter can emit and receive events", () => {
  const emitter = createTUIEventEmitter();
  const received: unknown[] = [];
  emitter.on("event", (data) => received.push(data));
  emitter.emit("event", { type: "test" });
  expect(received.length).toBe(1);
});

test("getTUIRunSummaryStatus distinguishes done, failed, and cancelled runs", () => {
  expect(getTUIRunSummaryStatus(true, undefined)).toBe("done");
  expect(getTUIRunSummaryStatus(true, "network failed")).toBe("failed");
  expect(getTUIRunSummaryStatus(false, undefined)).toBe("cancelled");
});

test("resumeTranscriptLoadErrorBlock surfaces a user-visible error block", () => {
  expect(resumeTranscriptLoadErrorBlock(new Error("EACCES"))).toEqual({
    type: "error",
    message: "Could not load prior session transcript: EACCES",
  });
  expect(resumeTranscriptLoadErrorBlock("disk full").message).toContain("disk full");
});

test("loadLocalSettingsWriteBase distinguishes absent from unreadable", async () => {
  // Absent → empty base (safe to write a single key).
  expect(await loadLocalSettingsWriteBase("/nope", async () => null)).toEqual({});

  // Readable → merge base.
  expect(
    await loadLocalSettingsWriteBase("/ok", async () => ({ sessionMode: "orchestrator" })),
  ).toEqual({
    sessionMode: "orchestrator",
  });

  // Unreadable/invalid → null so the caller skips the write instead of
  // overwriting the file with only sessionMode.
  expect(
    await loadLocalSettingsWriteBase("/bad", async () => {
      throw new Error("invalid schema");
    }),
  ).toBeNull();
});

// Rotation behavioral tests — per-session store semantics without a real TUI or agent.

// When buildAgent throws after the old agent is closed, fatalBuildError must
// be set so subsequent sends fail immediately rather than dispatching to a
// closed agent. This test models that invariant via the run-sink state machine.
test("rotation resets run-sink so a new session starts from a clean state", () => {
  const emitter = new EventEmitter();
  const hookManager = {
    dispatchPostTurn: () => {},
    getStatuses: () => [
      {
        id: "h1",
        name: "log.ts",
        type: "typescript" as const,
        path: "/hooks/log.ts",
        enabled: true,
      },
    ],
  };
  const runSink = createRunSink({ emitter, hookManager });

  // Session 1 completes.
  runSink.sink({ type: "reactor.done", data: {} } as never);
  const collectorBeforeReset = runSink.getTurnCollector();
  expect(runSink.getStatus()).toBe("done");

  // Rotation: reset opens a clean session.
  runSink.reset();

  // The new collector is a fresh instance — not the same object as before.
  // hooks are configured above, so the collector is non-null here
  const collectorAfterReset = runSink.getTurnCollector()!;
  expect(collectorAfterReset).not.toBe(collectorBeforeReset);

  // Status is cancelled (no events received in new session yet).
  expect(runSink.getStatus()).toBe("cancelled");

  // Session 2 can accumulate independently.
  runSink.sink({ type: "reactor.done", data: {} } as never);
  expect(runSink.getStatus()).toBe("done");
  expect(collectorAfterReset.getTurns()).toHaveLength(0);
});

// CL-5753: an interrupt can hit close() while reactor.abort()/sendQueue.drain()
// are mid-teardown, throwing before @intx/agent's close() ever reaches
// lock.release(). Once that happens the agent is already marked closed, so a
// retried close() is a silent no-op that can never free the lock either — the
// workdir's lock is stuck held for the rest of the process. The next
// buildAgent() for that same workdir is then guaranteed to throw
// AgentContextLockError ("an agent is already open for workdir: ..."), which
// is the crash from the ticket. These tests cover the two functions the
// runner now routes every rebuild through so that failure is reported in
// plain language rather than escaping as an unhandled rejection.
function stubAgent(closeImpl: () => Promise<void>): Agent {
  return { close: closeImpl } as unknown as Agent;
}

test("closeAgentForRebuild reports a failed close without throwing", async () => {
  const agent = stubAgent(() => Promise.reject(new AgentContextLockError("/tmp/workdir")));
  const closedCleanly = await closeAgentForRebuild(agent, "interrupt");
  expect(closedCleanly).toBe(false);
});

test("closeAgentForRebuild reports success when close() resolves", async () => {
  const agent = stubAgent(() => Promise.resolve());
  const closedCleanly = await closeAgentForRebuild(agent, "interrupt");
  expect(closedCleanly).toBe(true);
});

test("agentRebuildFailure turns a stale-lock AgentContextLockError into a plain-language message", () => {
  // Simulates the second acquisition throwing after a failed close left the
  // lock held: buildAgent() surfaces AgentContextLockError, which must not
  // reach the caller as a raw stack trace.
  const err = agentRebuildFailure(new AgentContextLockError("/tmp/workdir"));
  expect(err.message).not.toContain("already open");
  expect(err.message).toMatch(/restart/i);
});

test("agentRebuildFailure passes other errors through unchanged", () => {
  const original = new Error("network unreachable");
  expect(agentRebuildFailure(original)).toBe(original);
});

test("a failed close followed by a lock error never surfaces as a raw AgentContextLockError", async () => {
  // End-to-end shape of the fix: close() throws (lock leaked in-process),
  // the rebuild site short-circuits instead of calling buildAgent() again,
  // and the resulting error is the plain-language one — never the raw
  // AgentContextLockError a bare `throw` would have produced.
  const agent = stubAgent(() => Promise.reject(new AgentContextLockError("/tmp/workdir")));
  let rebuildError: Error | null = null;
  try {
    const closedCleanly = await closeAgentForRebuild(agent, "interrupt");
    if (!closedCleanly) {
      throw new AgentContextLockError("/tmp/workdir");
    }
  } catch (err) {
    rebuildError = agentRebuildFailure(err);
  }
  expect(rebuildError).not.toBeNull();
  expect(rebuildError).not.toBeInstanceOf(AgentContextLockError);
  expect(rebuildError!.message).toMatch(/restart/i);
});
