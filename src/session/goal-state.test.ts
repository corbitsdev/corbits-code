import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGoalState, saveGoalState, writeGoalStateRaw } from "./goal-state.js";

describe("goal state persistence", () => {
  test("round-trips an active goal and deletes on clear", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "goal-state-"));
    try {
      await saveGoalState(cwd, "s1", {
        status: "active",
        condition: "tests green",
        startedAt: 100,
        turnBudget: 25,
        turnsUsed: 3,
        mainTokens: 10,
        evalTokens: 2,
        lastReason: "still failing",
      });
      const loaded = await loadGoalState(cwd, "s1");
      expect(loaded?.condition).toBe("tests green");
      expect(loaded?.turnsUsed).toBe(3);

      await saveGoalState(cwd, "s1", null);
      expect(await loadGoalState(cwd, "s1")).toBeNull();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("round-trips brief and criteria", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "goal-state-"));
    try {
      await saveGoalState(cwd, "s1", {
        status: "active",
        condition: "typecheck; tests",
        brief: "ship the feature",
        criteria: [
          { id: "c1", title: "typecheck clean", status: "done" },
          { id: "c2", title: "tests green", status: "todo", note: "2 failing" },
        ],
        startedAt: 100,
        turnBudget: 0,
        turnsUsed: 3,
        mainTokens: 10,
        evalTokens: 2,
      });
      const loaded = await loadGoalState(cwd, "s1");
      expect(loaded?.brief).toBe("ship the feature");
      expect(loaded?.criteria).toHaveLength(2);
      expect(loaded?.criteria?.[0]?.status).toBe("done");
      expect(loaded?.criteria?.[1]?.note).toBe("2 failing");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("ignores corrupt JSON", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "goal-state-"));
    try {
      await writeGoalStateRaw(cwd, "s1", "{not json");
      expect(await loadGoalState(cwd, "s1")).toBeNull();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("rejects an unknown goal status", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "goal-state-"));
    try {
      await writeGoalStateRaw(
        cwd,
        "s1",
        JSON.stringify({
          status: "in_progress",
          condition: "tests green",
          startedAt: 100,
          turnBudget: 25,
          turnsUsed: 3,
          mainTokens: 10,
          evalTokens: 2,
        }),
      );
      expect(await loadGoalState(cwd, "s1")).toBeNull();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("rejects a criterion with an unknown status", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "goal-state-"));
    try {
      await writeGoalStateRaw(
        cwd,
        "s1",
        JSON.stringify({
          status: "active",
          condition: "tests green",
          criteria: [{ id: "c1", title: "typecheck clean", status: "in_review" }],
          startedAt: 100,
          turnBudget: 25,
          turnsUsed: 3,
          mainTokens: 10,
          evalTokens: 2,
        }),
      );
      expect(await loadGoalState(cwd, "s1")).toBeNull();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("rejects a criterion with an empty title", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "goal-state-"));
    try {
      await writeGoalStateRaw(
        cwd,
        "s1",
        JSON.stringify({
          status: "active",
          condition: "tests green",
          criteria: [{ id: "c1", title: "", status: "todo" }],
          startedAt: 100,
          turnBudget: 25,
          turnsUsed: 3,
          mainTokens: 10,
          evalTokens: 2,
        }),
      );
      expect(await loadGoalState(cwd, "s1")).toBeNull();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
