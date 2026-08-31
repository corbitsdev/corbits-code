import { describe, expect, test } from "bun:test";

import {
  isAlreadyClosed,
  isLiveStrip,
  isResumableLifecycle,
  projectLifecycleStatus,
  projectStripStatus,
  type StripStatus,
  type WorkerLifecycle,
} from "./lifecycle.js";

describe("WorkerLifecycle projections", () => {
  test("strip status maps each stored state", () => {
    const cases: [WorkerLifecycle, StripStatus][] = [
      [{ state: "pending_init" }, "running"],
      [{ state: "running" }, "running"],
      [{ state: "interrupted" }, "running"],
      [{ state: "completed", report: "ok" }, "done"],
      [{ state: "failed", error: "boom" }, "failed"],
      [{ state: "cancelled", error: "stop" }, "cancelled"],
      [{ state: "shutdown" }, "cancelled"],
    ];
    for (const [lifecycle, status] of cases) {
      expect(projectStripStatus(lifecycle)).toBe(status);
    }
  });

  test("verb lifecycleStatus does not leak cancelled or failed", () => {
    expect(projectLifecycleStatus({ state: "pending_init" })).toBe("pending_init");
    expect(projectLifecycleStatus({ state: "running" })).toBe("running");
    expect(projectLifecycleStatus({ state: "completed", report: "ok" })).toBe("completed");
    expect(projectLifecycleStatus({ state: "interrupted" })).toBe("interrupted");
    expect(projectLifecycleStatus({ state: "cancelled" })).toBe("interrupted");
    expect(projectLifecycleStatus({ state: "failed", error: "boom" })).toBe("shutdown");
    expect(projectLifecycleStatus({ state: "shutdown" })).toBe("shutdown");
  });

  test("resume gate is retained completed or interrupted only", () => {
    expect(isResumableLifecycle(true, { state: "completed", report: "ok" })).toBe(true);
    expect(isResumableLifecycle(true, { state: "interrupted" })).toBe(true);
    expect(isResumableLifecycle(true, { state: "cancelled" })).toBe(false);
    expect(isResumableLifecycle(true, { state: "failed", error: "x" })).toBe(false);
    expect(isResumableLifecycle(true, { state: "shutdown" })).toBe(false);
    expect(isResumableLifecycle(false, { state: "completed", report: "ok" })).toBe(false);
    expect(isResumableLifecycle(undefined, { state: "interrupted" })).toBe(false);
  });

  test("live strip is pending_init, running, and interrupted", () => {
    expect(isLiveStrip({ state: "pending_init" })).toBe(true);
    expect(isLiveStrip({ state: "running" })).toBe(true);
    expect(isLiveStrip({ state: "interrupted" })).toBe(true);
    expect(isLiveStrip({ state: "completed", report: "ok" })).toBe(false);
    expect(isLiveStrip({ state: "cancelled" })).toBe(false);
    expect(isLiveStrip({ state: "failed", error: "x" })).toBe(false);
    expect(isLiveStrip({ state: "shutdown" })).toBe(false);
  });

  test("already-closed is failed or shutdown so close_agent does not wait", () => {
    expect(isAlreadyClosed({ state: "failed", error: "x" })).toBe(true);
    expect(isAlreadyClosed({ state: "shutdown" })).toBe(true);
    expect(isAlreadyClosed({ state: "pending_init" })).toBe(false);
    expect(isAlreadyClosed({ state: "running" })).toBe(false);
    expect(isAlreadyClosed({ state: "interrupted" })).toBe(false);
    expect(isAlreadyClosed({ state: "completed", report: "ok" })).toBe(false);
    expect(isAlreadyClosed({ state: "cancelled" })).toBe(false);
  });
});
