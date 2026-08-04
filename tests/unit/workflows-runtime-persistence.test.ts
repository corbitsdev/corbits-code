import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "../helpers/workflows.js";
import { findWorkflow } from "../../src/workflows/index.js";
import { WorkflowRuntime } from "../../src/workflows/runtime.js";
import { loadWorkflowState, saveWorkflowState } from "../../src/workflows/state.js";

test("WorkflowRuntime resumes from workflow.json written mid sub-workflow chain", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wf-runtime-persist-"));
  const home = await mkdtemp(join(tmpdir(), "wf-runtime-persist-home-"));
  try {
    const build = findWorkflow("build");
    expect(build).toBeDefined();

    const runtime = new WorkflowRuntime(new Map());
    runtime.start(build!);
    const first = runtime.currentStep()?.id;
    runtime.advance();
    const mid = runtime.currentStep()?.id;
    expect(first).toBeDefined();
    expect(mid).toBeDefined();
    expect(mid).not.toBe(first);

    await saveWorkflowState(cwd, "session-1", runtime.state(), home);
    const loaded = await loadWorkflowState(cwd, "session-1", home);
    expect(loaded).toEqual(runtime.state());

    const resumed = new WorkflowRuntime(new Map());
    resumed.restore(loaded!);
    expect(resumed.currentStep()?.id).toBe(mid);
    resumed.advance();
    expect(resumed.isActive()).toBe(true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
