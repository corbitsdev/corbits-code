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

  test("ignores corrupt JSON", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "goal-state-"));
    try {
      await writeGoalStateRaw(cwd, "s1", "{not json");
      expect(await loadGoalState(cwd, "s1")).toBeNull();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
