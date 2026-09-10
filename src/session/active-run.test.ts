import { describe, expect, test } from "bun:test";

import {
  clearActiveRun,
  getActiveRun,
  setActiveRun,
  syncRunStateHandle,
  type RunStateHandle,
} from "./active-run.js";

describe("syncRunStateHandle", () => {
  test("updates turnsUsed and identity fields on the live handle", () => {
    clearActiveRun();
    const handle: RunStateHandle = {
      sessionId: "sess",
      cwd: "/tmp",
      task: "old",
      startedAt: 1,
      turnsUsed: 0,
      model: "provider:old",
    };
    setActiveRun(handle);

    syncRunStateHandle(handle, {
      turnsUsed: 7,
      task: "new",
      startedAt: 42,
      model: "provider:new",
    });

    expect(getActiveRun()).toBe(handle);
    expect(handle.turnsUsed).toBe(7);
    expect(handle.task).toBe("new");
    expect(handle.startedAt).toBe(42);
    expect(handle.model).toBe("provider:new");
    clearActiveRun();
  });
});
