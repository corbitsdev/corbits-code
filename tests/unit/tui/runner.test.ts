import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import {
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
