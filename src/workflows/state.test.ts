import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionDir } from "../session/index.js";
import { saveWorkflowState, loadWorkflowState } from "./state.js";
import type { WorkflowState } from "./types.js";

const SESSION_ID = "session-1";

const sampleState: WorkflowState = {
  stack: [
    {
      workflow: "parent",
      stepIndex: 1,
      statuses: ["completed", "active", "pending"],
    },
    { workflow: "child", stepIndex: 0, statuses: ["active"] },
  ],
  completed: false,
};

describe("workflow state persistence", () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "wf-state-"));
    home = await mkdtemp(join(tmpdir(), "wf-state-home-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  test("saveWorkflowState then loadWorkflowState returns an equal object", async () => {
    await saveWorkflowState(cwd, SESSION_ID, sampleState, home);
    const loaded = await loadWorkflowState(cwd, SESSION_ID, home);
    expect(loaded).toEqual(sampleState);
  });

  test("loadWorkflowState on missing file returns null", async () => {
    expect(await loadWorkflowState(cwd, "nope", home)).toBeNull();
  });

  test("loadWorkflowState returns null instead of throwing on malformed files", async () => {
    const malformed: string[] = [
      // truncated JSON
      '{ "completed": false, "stack": [',
      // invalid stepIndex
      JSON.stringify({
        completed: false,
        stack: [{ workflow: "review", stepIndex: 1.5, statuses: ["active"] }],
      }),
      // unknown step status
      JSON.stringify({
        completed: false,
        stack: [{ workflow: "review", stepIndex: 0, statuses: ["running"] }],
      }),
    ];
    for (const raw of malformed) {
      const dir = sessionDir(cwd, SESSION_ID, home);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "workflow.json"), raw);
      expect(await loadWorkflowState(cwd, SESSION_ID, home)).toBeNull();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("saveWorkflowState leaves no .tmp file after successful write", async () => {
    await saveWorkflowState(cwd, SESSION_ID, sampleState, home);
    const files = await readdir(sessionDir(cwd, SESSION_ID, home));
    expect(files.filter((f) => f.includes(".tmp"))).toHaveLength(0);
  });

  test("saveWorkflowState overwrites a pre-existing file with well-formed JSON", async () => {
    await saveWorkflowState(cwd, SESSION_ID, sampleState, home);
    const updated: WorkflowState = {
      ...sampleState,
      completed: true,
      stack: [],
    };
    await saveWorkflowState(cwd, SESSION_ID, updated, home);
    const raw = await readFile(
      join(sessionDir(cwd, SESSION_ID, home), "workflow.json"),
      "utf8",
    );
    expect(JSON.parse(raw)).toEqual(updated);
  });

  test("concurrent saveWorkflowState calls serialize and leave valid JSON", async () => {
    await Promise.all([
      saveWorkflowState(cwd, SESSION_ID, sampleState, home),
      saveWorkflowState(
        cwd,
        SESSION_ID,
        { ...sampleState, completed: true },
        home,
      ),
      saveWorkflowState(cwd, SESSION_ID, sampleState, home),
    ]);
    const loaded = await loadWorkflowState(cwd, SESSION_ID, home);
    expect(loaded).not.toBeNull();
    expect(loaded?.stack).toEqual(sampleState.stack);
  });
});
