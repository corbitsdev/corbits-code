import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { createRunSink, resolveExecRunStatus } from "../../../src/session/run-sink.js";

describe("resolveExecRunStatus", () => {
  test("maps successful send to done even when sink is cancelled (no reactor.done)", () => {
    expect(
      resolveExecRunStatus({
        sendCompleted: true,
        sinkStatus: "cancelled",
        runError: undefined,
      }),
    ).toBe("done");
  });

  test("maps real run error to failed even after send completes", () => {
    expect(
      resolveExecRunStatus({
        sendCompleted: true,
        sinkStatus: "cancelled",
        runError: "boom",
      }),
    ).toBe("failed");
  });

  test("maps sink failed to failed", () => {
    expect(
      resolveExecRunStatus({
        sendCompleted: false,
        sinkStatus: "failed",
        runError: undefined,
      }),
    ).toBe("failed");
  });

  test("maps incomplete send without sink done to cancelled", () => {
    expect(
      resolveExecRunStatus({
        sendCompleted: false,
        sinkStatus: "cancelled",
        runError: undefined,
      }),
    ).toBe("cancelled");
  });

  test("maps sink done without sendCompleted to done", () => {
    expect(
      resolveExecRunStatus({
        sendCompleted: false,
        sinkStatus: "done",
        runError: undefined,
      }),
    ).toBe("done");
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
