import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { createRunSink, resolveExecRunStatus } from "./run-sink.js";

describe("resolveExecRunStatus", () => {
  // Truth table over the three inputs. The load-bearing rows: a completed
  // send finishes the run even if the sink never saw reactor.done, and a
  // real run error beats both send completion and sink status.
  test.each([
    {
      name: "successful send maps to done even when sink is cancelled (no reactor.done)",
      input: {
        sendCompleted: true,
        sinkStatus: "cancelled" as const,
        runError: undefined,
      },
      expected: "done",
    },
    {
      name: "real run error maps to failed even after send completes",
      input: {
        sendCompleted: true,
        sinkStatus: "cancelled" as const,
        runError: "boom",
      },
      expected: "failed",
    },
    {
      name: "sink failed maps to failed",
      input: {
        sendCompleted: false,
        sinkStatus: "failed" as const,
        runError: undefined,
      },
      expected: "failed",
    },
    {
      name: "incomplete send without sink done maps to cancelled",
      input: {
        sendCompleted: false,
        sinkStatus: "cancelled" as const,
        runError: undefined,
      },
      expected: "cancelled",
    },
    {
      name: "sink done without sendCompleted maps to done",
      input: {
        sendCompleted: false,
        sinkStatus: "done" as const,
        runError: undefined,
      },
      expected: "done",
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveExecRunStatus(input)).toBe(expected);
  });
});

describe("createRunSink sticky inference.error", () => {
  test("inference.done after inference.error clears sticky run error", () => {
    const emitter = new EventEmitter();
    const runSink = createRunSink({
      emitter,
      hookManager: { dispatchPostTurn: () => undefined, getStatuses: () => [] },
    });

    runSink.sink({
      type: "inference.error",
      data: { error: { message: "timeout" } },
    } as never);
    expect(runSink.getStatus()).toBe("failed");
    expect(runSink.getRunError()).toBe("timeout");

    // ChatDirector retried; a later turn completed successfully.
    runSink.sink({
      type: "inference.done",
      data: {
        turn: { content: [] },
        usage: {},
        source: "primary",
      },
    } as never);
    expect(runSink.getRunError()).toBeUndefined();
    // Still cancelled until reactor.done — sticky error is cleared though.
    expect(runSink.getStatus()).toBe("cancelled");
  });

  test("reactor.done clears sticky error and marks done", () => {
    const emitter = new EventEmitter();
    const runSink = createRunSink({
      emitter,
      hookManager: { dispatchPostTurn: () => undefined, getStatuses: () => [] },
    });

    runSink.sink({
      type: "inference.error",
      data: { error: { message: "transient" } },
    } as never);
    runSink.sink({ type: "reactor.done", data: {} } as never);
    expect(runSink.getStatus()).toBe("done");
    expect(runSink.getRunError()).toBeUndefined();
  });
});
