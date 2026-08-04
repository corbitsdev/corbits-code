import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionDir } from "../../src/session/index.js";
import { saveWorkflowState, loadWorkflowState } from "../../src/workflows/state.js";
import type { WorkflowState } from "../../src/workflows/types.js";

const SESSION_ID = "session-1";

const sampleState: WorkflowState = {
  stack: [
    { workflow: "parent", stepIndex: 1, statuses: ["completed", "active", "pending"] },
    { workflow: "child", stepIndex: 0, statuses: ["active"] },
  ],
  completed: false,
};

describe("workflow state persistence", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "wf-state-"));
  });

  afterEach(async () => {
    await rm(sessionDir(cwd, SESSION_ID), { recursive: true, force: true }).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  });

  test("saveWorkflowState then loadWorkflowState returns an equal object", async () => {
    await saveWorkflowState(cwd, SESSION_ID, sampleState);
    const loaded = await loadWorkflowState(cwd, SESSION_ID);
    expect(loaded).toEqual(sampleState);
  });

  test("loadWorkflowState on missing file returns null", async () => {
    expect(await loadWorkflowState(cwd, "nope")).toBeNull();
  });

  test("loadWorkflowState with truncated JSON returns null instead of throwing", async () => {
    const dir = sessionDir(cwd, SESSION_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "workflow.json"), '{ "completed": false, "stack": [');

    expect(await loadWorkflowState(cwd, SESSION_ID)).toBeNull();
  });

  test("loadWorkflowState rejects invalid stepIndex values", async () => {
    const dir = sessionDir(cwd, SESSION_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "workflow.json"),
      JSON.stringify({
        completed: false,
        stack: [{ workflow: "review", stepIndex: 1.5, statuses: ["active"] }],
      }),
    );

    expect(await loadWorkflowState(cwd, SESSION_ID)).toBeNull();
  });

  test("loadWorkflowState rejects unknown step statuses", async () => {
    const dir = sessionDir(cwd, SESSION_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "workflow.json"),
      JSON.stringify({
        completed: false,
        stack: [{ workflow: "review", stepIndex: 0, statuses: ["running"] }],
      }),
    );

    expect(await loadWorkflowState(cwd, SESSION_ID)).toBeNull();
  });

  test("saveWorkflowState leaves no .tmp file after successful write", async () => {
    await saveWorkflowState(cwd, SESSION_ID, sampleState);
    const files = await readdir(sessionDir(cwd, SESSION_ID));
    expect(files.filter((f) => f.includes(".tmp"))).toHaveLength(0);
  });

  test("saveWorkflowState overwrites a pre-existing file with well-formed JSON", async () => {
    await saveWorkflowState(cwd, SESSION_ID, sampleState);
    const updated: WorkflowState = { ...sampleState, completed: true, stack: [] };
    await saveWorkflowState(cwd, SESSION_ID, updated);
    const raw = await readFile(join(sessionDir(cwd, SESSION_ID), "workflow.json"), "utf8");
    expect(JSON.parse(raw)).toEqual(updated);
  });

  test("concurrent saveWorkflowState calls serialize and leave valid JSON", async () => {
    await Promise.all([
      saveWorkflowState(cwd, SESSION_ID, sampleState),
      saveWorkflowState(cwd, SESSION_ID, { ...sampleState, completed: true }),
      saveWorkflowState(cwd, SESSION_ID, sampleState),
    ]);
    const loaded = await loadWorkflowState(cwd, SESSION_ID);
    expect(loaded).not.toBeNull();
    expect(loaded?.stack).toEqual(sampleState.stack);
  });
});
