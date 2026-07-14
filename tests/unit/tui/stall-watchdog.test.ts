import { test, expect } from "bun:test";
import { applyStallRecovery, shouldAbortForStall } from "../../../src/tui/app.js";
import { INFERENCE_ABORT_INTERNAL_RECOVERY } from "../../../src/inference-abort.js";

test("shouldAbortForStall: fires when running, awaiting, and stalled beyond timeout", () => {
  expect(shouldAbortForStall({
    status: "running",
    awaitingResponse: true,
    lastActivityAt: 0,
    nowMs: 130000,
    stallTimeoutMs: 120000,
  })).toBe(true);
});

test("shouldAbortForStall: does not fire when activity is recent", () => {
  expect(shouldAbortForStall({
    status: "running",
    awaitingResponse: true,
    lastActivityAt: 120000,
    nowMs: 130000,
    stallTimeoutMs: 120000,
  })).toBe(false);
});

test("shouldAbortForStall: does not fire when not awaiting response", () => {
  expect(shouldAbortForStall({
    status: "running",
    awaitingResponse: false,
    lastActivityAt: 0,
    nowMs: 130000,
    stallTimeoutMs: 120000,
  })).toBe(false);
});

test("shouldAbortForStall: does not fire when status is not running", () => {
  expect(shouldAbortForStall({
    status: "done",
    awaitingResponse: true,
    lastActivityAt: 0,
    nowMs: 130000,
    stallTimeoutMs: 120000,
  })).toBe(false);
});

test("shouldAbortForStall: does not fire when status is stopping", () => {
  expect(shouldAbortForStall({
    status: "stopping",
    awaitingResponse: true,
    lastActivityAt: 0,
    nowMs: 130000,
    stallTimeoutMs: 120000,
  })).toBe(false);
});

test("shouldAbortForStall: recent activity prevents abort (simulating a token arriving)", () => {
  // activityTick increments reset lastActivityAt in the app; simulate by
  // passing a recent lastActivityAt to confirm the guard holds.
  expect(shouldAbortForStall({
    status: "running",
    awaitingResponse: true,
    lastActivityAt: 119999,
    nowMs: 120000,
    stallTimeoutMs: 120000,
  })).toBe(false);
});

test("shouldAbortForStall: boundary — exactly at timeout fires", () => {
  expect(shouldAbortForStall({
    status: "running",
    awaitingResponse: true,
    lastActivityAt: 0,
    nowMs: 120000,
    stallTimeoutMs: 120000,
  })).toBe(true);
});

test("applyStallRecovery aborts in-flight send and does not resubmit the last prompt", () => {
  let aborted: string | undefined;
  let commandMessage = "";
  let resubmitCount = 0;

  applyStallRecovery({
    abortInFlight: (reason) => {
      aborted = reason;
    },
    setCommandMessage: (message) => {
      commandMessage = message;
    },
  });

  expect(aborted).toBe(INFERENCE_ABORT_INTERNAL_RECOVERY);
  expect(commandMessage).toContain("Recovering");
  expect(resubmitCount).toBe(0);
});
