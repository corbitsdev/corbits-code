import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveWorkflowState, loadWorkflowState } from "../../src/workflows/state.js";
import type { WorkflowState } from "../../src/workflows/types.js";

test("workflow state round-trips through save and load", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wf-state-"));
  try {
    const state: WorkflowState = {
      stack: [
        { workflow: "parent", stepIndex: 1, statuses: ["completed", "active", "pending"] },
        { workflow: "child", stepIndex: 0, statuses: ["active"] },
      ],
      completed: false,
    };
    await saveWorkflowState(cwd, "session-1", state);
    const loaded = await loadWorkflowState(cwd, "session-1");
    expect(loaded).toEqual(state);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("loading a missing workflow state returns null", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wf-state-"));
  try {
    expect(await loadWorkflowState(cwd, "nope")).toBeNull();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
