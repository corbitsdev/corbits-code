import { test, expect } from "bun:test";
import { applyStallRecovery, shouldAbortForStall } from "../../../src/tui/app.js";
import { INFERENCE_ABORT_INTERNAL_RECOVERY } from "../../../src/inference-abort.js";

const base = {
  status: "running" as const,
  lastActivityAt: 0,
  nowMs: 130_000,
  stallTimeoutMs: 120_000,
  isProcessing: true,
  streamingType: null as "text" | "thinking" | "tool" | null,
};

test("shouldAbortForStall: fires when running, awaiting, and stalled beyond timeout", () => {
  expect(shouldAbortForStall({
    ...base,
    awaitingResponse: true,
  })).toBe(true);
});

test("shouldAbortForStall: does not fire when activity is recent", () => {
  expect(shouldAbortForStall({
    ...base,
    awaitingResponse: true,
    lastActivityAt: 120_000,
  })).toBe(false);
});

test("shouldAbortForStall: does not fire when not awaiting and not mid-stream", () => {
  expect(shouldAbortForStall({
    ...base,
    awaitingResponse: false,
    isProcessing: false,
    streamingType: null,
  })).toBe(false);
});

test("shouldAbortForStall: fires on mid-thinking silence beyond timeout", () => {
  expect(shouldAbortForStall({
    ...base,
    awaitingResponse: false,
    isProcessing: true,
    streamingType: "thinking",
  })).toBe(true);
});

test("shouldAbortForStall: does not fire on long tool execution without parent stream events", () => {
  expect(shouldAbortForStall({
    ...base,
    awaitingResponse: false,
    isProcessing: true,
    streamingType: "tool",
  })).toBe(false);
});

test("shouldAbortForStall: mid-stream with recent tokens does not fire", () => {
  expect(shouldAbortForStall({
    ...base,
    awaitingResponse: false,
    isProcessing: true,
    streamingType: "thinking",
    lastActivityAt: 120_000,
  })).toBe(false);
});

test("shouldAbortForStall: does not fire when status is not running", () => {
  expect(shouldAbortForStall({
    ...base,
    status: "done",
    awaitingResponse: true,
  })).toBe(false);
});

test("shouldAbortForStall: does not fire when status is stopping", () => {
  expect(shouldAbortForStall({
    ...base,
    status: "stopping",
    awaitingResponse: true,
  })).toBe(false);
});

test("shouldAbortForStall: recent activity prevents abort (simulating a token arriving)", () => {
  expect(shouldAbortForStall({
    ...base,
    awaitingResponse: true,
    lastActivityAt: 119_999,
    nowMs: 120_000,
  })).toBe(false);
});

test("shouldAbortForStall: boundary — exactly at timeout fires", () => {
  expect(shouldAbortForStall({
    ...base,
    awaitingResponse: true,
    nowMs: 120_000,
    lastActivityAt: 0,
  })).toBe(true);
});

test("applyStallRecovery aborts in-flight send with internal-recovery reason", () => {
  let aborted: string | undefined;
  let commandMessage = "";

  applyStallRecovery({
    abortInFlight: (reason) => {
      aborted = reason;
    },
    setCommandMessage: (message) => {
      commandMessage = message;
    },
  });

  expect(aborted).toBe(INFERENCE_ABORT_INTERNAL_RECOVERY);
  expect(commandMessage).toBe("Recovering after an internal stall...");
});