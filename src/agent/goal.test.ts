import { describe, expect, test } from "bun:test";
import type { ReactorAction, ReactorCapabilities } from "@intx/types/runtime";
import {
  createGoalGovernor,
  formatGoalStatus,
  formatGoalTurns,
  goalKickoffUserMessage,
  isUnlimitedTurnBudget,
  DEFAULT_GOAL_TURN_BUDGET,
  type GoalCriterion,
  type GoalEvaluateFn,
  type GoalInterceptContext,
} from "./goal.js";

const capabilities = {
  infer: (options?: unknown) =>
    ({ type: "infer", ...(options !== undefined ? { options } : {}) }) as ReactorAction,
  reply: (content: string) => ({ type: "reply", content }) as ReactorAction,
  wait: () => ({ type: "wait" }) as ReactorAction,
} as unknown as ReactorCapabilities;

const waitTerminal: ReactorAction[] = [{ type: "wait" }];
const replyTerminal: ReactorAction[] = [{ type: "reply", content: "done for now" }];
const inferAction: ReactorAction[] = [{ type: "infer" }];

function ctx(partial?: Partial<GoalInterceptContext>): GoalInterceptContext {
  return {
    atWorkflowGate: false,
    lastTurnHadContent: true,
    evidence: "tests pass; files updated",
    ...partial,
  };
}

function alwaysNotMet(reason = "not yet"): GoalEvaluateFn {
  return async () => ({ met: false, reason });
}

function alwaysMet(reason = "condition satisfied"): GoalEvaluateFn {
  return async () => ({ met: true, reason });
}

function failingEval(message = "network down"): GoalEvaluateFn {
  return async () => ({ met: false, reason: message, error: true });
}

/** Minimal two-item checklist so intercept uses the criteria path. */
function seedCriteria(
  g: ReturnType<typeof createGoalGovernor>,
  statuses: Array<GoalCriterion["status"]> = ["todo", "todo"],
): void {
  g.setCriteria(
    statuses.map((status, i) => ({
      id: `c${i + 1}`,
      title: `criterion ${i + 1}`,
      status,
    })),
  );
}

describe("goal governor state machine", () => {
  test("default turn budget is unlimited (0)", () => {
    expect(DEFAULT_GOAL_TURN_BUDGET).toBe(0);
    expect(isUnlimitedTurnBudget(0)).toBe(true);
    expect(isUnlimitedTurnBudget(25)).toBe(false);
    expect(formatGoalTurns(3, 0)).toBe("3/∞");
    expect(formatGoalTurns(3, 25)).toBe("3/25");

    const g = createGoalGovernor({ evaluate: alwaysNotMet(), now: () => 1000 });
    const first = g.set("all tests green");
    expect(first.turnBudget).toBe(0);
    expect(first.status).toBe("active");
    expect(first.brief).toBe("all tests green");
    expect(first.criteria).toEqual([]);
  });

  test("set activates and replace resets counters", () => {
    const g = createGoalGovernor({ evaluate: alwaysNotMet(), now: () => 1000 });
    expect(g.get()).toBeNull();

    const first = g.set("all tests green", { turnBudget: 10 });
    expect(first.status).toBe("active");
    expect(first.brief).toBe("all tests green");
    expect(first.condition).toBe("all tests green");
    expect(first.turnBudget).toBe(10);
    expect(first.startedAt).toBe(1000);

    const second = g.set("ship the feature");
    expect(second.brief).toBe("ship the feature");
    expect(second.turnsUsed).toBe(0);
    expect(second.status).toBe("active");
    expect(second.turnBudget).toBe(0);
    expect(second.criteria).toEqual([]);
  });

  test("setCriteria expands the real goal and synthesizes condition", () => {
    const g = createGoalGovernor({ evaluate: alwaysNotMet() });
    g.set("ship the feature");
    const snap = g.setCriteria([
      { id: "c1", title: "typecheck clean", status: "todo" },
      { id: "c2", title: "tests green", status: "todo" },
    ]);
    expect(snap?.criteria).toHaveLength(2);
    expect(snap?.condition).toContain("typecheck clean");
    expect(snap?.condition).toContain("tests green");
    expect(snap?.brief).toBe("ship the feature");
  });

  test("updateCriteria patches status and notes", () => {
    const g = createGoalGovernor({ evaluate: alwaysNotMet() });
    g.set("ship");
    g.setCriteria([
      { id: "c1", title: "a", status: "todo" },
      { id: "c2", title: "b", status: "todo" },
    ]);
    const snap = g.updateCriteria([{ id: "c1", status: "done", note: "verified" }]);
    expect(snap?.criteria.find((c) => c.id === "c1")?.status).toBe("done");
    expect(snap?.criteria.find((c) => c.id === "c1")?.note).toBe("verified");
    expect(snap?.criteria.find((c) => c.id === "c2")?.status).toBe("todo");
  });

  test("pause and resume extend a finite turn budget", () => {
    const g = createGoalGovernor({
      evaluate: alwaysNotMet(),
      defaultTurnBudget: 5,
      defaultResumeExtend: 10,
    });
    g.set("x");
    expect(g.pause()?.status).toBe("paused");
    expect(g.resume()?.status).toBe("active");
    expect(g.get()?.turnBudget).toBe(10);
  });

  test("resume keeps unlimited turn budget unlimited", () => {
    const g = createGoalGovernor({ evaluate: alwaysNotMet() });
    g.set("ship it");
    expect(g.get()?.turnBudget).toBe(0);
    g.pause();
    const resumed = g.resume();
    expect(resumed?.turnBudget).toBe(0);
    expect(resumed?.status).toBe("active");
  });

  test("clear returns to inactive", () => {
    const g = createGoalGovernor({ evaluate: alwaysNotMet() });
    g.set("x");
    g.clear();
    expect(g.get()).toBeNull();
  });

  test("restore turns active into paused and preserves criteria", () => {
    const g = createGoalGovernor({ evaluate: alwaysNotMet() });
    const paused = g.restore({
      status: "active",
      condition: "migrate auth",
      brief: "migrate auth",
      criteria: [{ id: "c1", title: "users can log in", status: "doing" }],
      startedAt: 50,
      turnBudget: 25,
      turnsUsed: 3,
    });
    expect(paused?.status).toBe("paused");
    expect(paused?.brief).toBe("migrate auth");
    expect(paused?.criteria).toHaveLength(1);
    expect(paused?.criteria[0]?.title).toBe("users can log in");
    expect(paused?.turnsUsed).toBe(3);

    g.restore({ status: "cleared", condition: "old", startedAt: 1, turnBudget: 5 });
    expect(g.get()).toBeNull();
  });

  test("restore falls back brief from condition for older goal.json", () => {
    const g = createGoalGovernor({ evaluate: alwaysNotMet() });
    const paused = g.restore({
      status: "active",
      condition: "legacy condition only",
      startedAt: 1,
      turnBudget: 0,
    });
    expect(paused?.brief).toBe("legacy condition only");
    expect(paused?.criteria).toEqual([]);
  });
});

describe("goalKickoffUserMessage", () => {
  test("set path requires clarify-before-work and manage_goal expansion", () => {
    const text = goalKickoffUserMessage("test goal", "set");
    expect(text).toContain("test goal");
    expect(text.toLowerCase()).toContain("clarif");
    expect(text).toMatch(/Do not run tests/i);
    expect(text).toMatch(/until success is defined/i);
    expect(text).toMatch(/do not invert/i);
    expect(text).toContain("manage_goal");
    expect(text).toMatch(/3–12|multi-item/i);
  });

  test("resume path continues without re-forcing full setup ritual", () => {
    const text = goalKickoffUserMessage("all tests pass", "resume");
    expect(text).toContain("resumed");
    expect(text).toContain("all tests pass");
    expect(text).not.toMatch(/Order of operations/i);
    expect(text).toContain("manage_goal");
  });
});

describe("goal interceptTerminal", () => {
  test("inactive is a no-op", async () => {
    const g = createGoalGovernor({ evaluate: alwaysNotMet() });
    expect(await g.interceptTerminal(waitTerminal, capabilities, ctx())).toBeNull();
  });

  test("paused is a no-op", async () => {
    const g = createGoalGovernor({ evaluate: alwaysNotMet() });
    g.set("x");
    g.pause();
    expect(await g.interceptTerminal(waitTerminal, capabilities, ctx())).toBeNull();
  });

  test("non-terminal actions are a no-op", async () => {
    const g = createGoalGovernor({ evaluate: alwaysNotMet() });
    g.set("x");
    expect(await g.interceptTerminal(inferAction, capabilities, ctx())).toBeNull();
  });

  test("workflow gate is a no-op", async () => {
    const g = createGoalGovernor({ evaluate: alwaysNotMet() });
    g.set("x");
    expect(
      await g.interceptTerminal(waitTerminal, capabilities, ctx({ atWorkflowGate: true })),
    ).toBeNull();
  });

  test("empty criteria nudges to manage_goal without calling evaluator", async () => {
    let evals = 0;
    const g = createGoalGovernor({
      evaluate: async () => {
        evals++;
        return { met: true, reason: "should not run" };
      },
    });
    g.set("vague goal");
    const actions = await g.interceptTerminal(waitTerminal, capabilities, ctx());
    expect(actions?.some((a) => a.type === "infer")).toBe(true);
    expect(evals).toBe(0);
    const infer = actions?.find((a) => a.type === "infer") as {
      type: "infer";
      options?: { ephemeralTurns?: Array<{ content: Array<{ type: string; text?: string }> }> };
    };
    const nudgeText = infer.options?.ephemeralTurns?.[0]?.content?.[0]?.text ?? "";
    expect(nudgeText).toContain("manage_goal");
    expect(nudgeText).toContain("Acceptance criteria not defined");
  });

  test("not-met rewrites wait into re-infer with checklist nudge", async () => {
    const g = createGoalGovernor({ evaluate: alwaysNotMet("still failing") });
    g.set("tests green");
    seedCriteria(g);
    const actions = await g.interceptTerminal(waitTerminal, capabilities, ctx());
    expect(actions).not.toBeNull();
    expect(actions?.some((a) => a.type === "wait")).toBe(false);
    expect(actions?.some((a) => a.type === "infer")).toBe(true);
    const infer = actions?.find((a) => a.type === "infer") as {
      type: "infer";
      options?: { ephemeralTurns?: Array<{ content: Array<{ type: string; text?: string }> }> };
    };
    const nudgeText = infer.options?.ephemeralTurns?.[0]?.content?.[0]?.text ?? "";
    expect(nudgeText).toContain("tests green");
    expect(nudgeText).toContain("criterion 1");
    expect(g.get()?.status).toBe("active");
    expect(g.get()?.turnsUsed).toBe(1);
  });

  test("all criteria done yields terminal and marks achieved", async () => {
    const g = createGoalGovernor({ evaluate: alwaysMet("all green") });
    g.set("tests green");
    seedCriteria(g, ["done", "done"]);
    const actions = await g.interceptTerminal(replyTerminal, capabilities, ctx());
    expect(actions).toBeNull();
    expect(g.get()?.status).toBe("achieved");
    expect(g.get()?.lastReason).toContain("All acceptance criteria");
  });

  test("evaluator met is ignored while criteria remain open", async () => {
    const g = createGoalGovernor({ evaluate: alwaysMet("llm says yes") });
    g.set("tests green");
    seedCriteria(g, ["todo", "done"]);
    const actions = await g.interceptTerminal(waitTerminal, capabilities, ctx());
    expect(actions?.some((a) => a.type === "infer")).toBe(true);
    expect(g.get()?.status).toBe("active");
  });

  test("fail-open treats evaluator errors as not-met", async () => {
    const g = createGoalGovernor({
      evaluate: failingEval("boom"),
      maxConsecutiveEvalFailures: 3,
    });
    g.set("x");
    seedCriteria(g);
    const actions = await g.interceptTerminal(waitTerminal, capabilities, ctx());
    expect(actions?.some((a) => a.type === "infer")).toBe(true);
    expect(g.get()?.status).toBe("active");
    expect(g.get()?.consecutiveEvalFailures).toBe(1);
  });

  test("consecutive evaluator failures pause the goal", async () => {
    const g = createGoalGovernor({
      evaluate: failingEval("boom"),
      maxConsecutiveEvalFailures: 2,
    });
    g.set("x");
    seedCriteria(g);
    expect(
      (await g.interceptTerminal(waitTerminal, capabilities, ctx()))?.some((a) => a.type === "infer"),
    ).toBe(true);
    const second = await g.interceptTerminal(waitTerminal, capabilities, ctx());
    expect(second).toBeNull();
    expect(g.get()?.status).toBe("paused");
    expect(g.get()?.lastReason).toContain("evaluator failures");
  });

  test("empty yields pause after the configured streak", async () => {
    let evals = 0;
    const g = createGoalGovernor({
      evaluate: async () => {
        evals++;
        return { met: false, reason: "should not run" };
      },
      maxConsecutiveEmptyYields: 2,
    });
    g.set("x");
    seedCriteria(g);
    const first = await g.interceptTerminal(
      waitTerminal,
      capabilities,
      ctx({ lastTurnHadContent: false }),
    );
    expect(first?.some((a) => a.type === "infer")).toBe(true);
    expect(evals).toBe(0);

    const second = await g.interceptTerminal(
      waitTerminal,
      capabilities,
      ctx({ lastTurnHadContent: false }),
    );
    expect(second).toBeNull();
    expect(g.get()?.status).toBe("paused");
    expect(evals).toBe(0);
  });

  test("turn budget allows one continue then soft-stops on the next not-met", async () => {
    const g = createGoalGovernor({
      evaluate: alwaysNotMet(),
      defaultTurnBudget: 1,
    });
    g.set("x", { turnBudget: 1 });
    seedCriteria(g);
    const first = await g.interceptTerminal(waitTerminal, capabilities, ctx());
    expect(first?.some((a) => a.type === "infer")).toBe(true);
    expect(g.get()?.turnsUsed).toBe(1);
    expect(g.get()?.status).toBe("active");

    const second = await g.interceptTerminal(waitTerminal, capabilities, ctx());
    expect(second).toBeNull();
    expect(g.get()?.status).toBe("budget_limited");
    expect(g.get()?.lastReason).toContain("Turn budget");
  });

  test("unlimited turn budget does not soft-stop on turns alone", async () => {
    const g = createGoalGovernor({ evaluate: alwaysNotMet() });
    g.set("keep going");
    seedCriteria(g);
    for (let i = 0; i < 30; i++) {
      const next = await g.interceptTerminal(waitTerminal, capabilities, ctx());
      expect(next?.some((a) => a.type === "infer")).toBe(true);
    }
    expect(g.get()?.status).toBe("active");
    expect(g.get()?.turnsUsed).toBe(30);
    expect(g.get()?.turnBudget).toBe(0);
  });

  test("token budget soft-stops when main+eval exceed the cap", async () => {
    const g = createGoalGovernor({
      evaluate: async () => ({ met: false, reason: "no", evalTokens: 50 }),
    });
    g.set("x", { tokenBudget: 100 });
    seedCriteria(g);
    const actions = await g.interceptTerminal(
      waitTerminal,
      capabilities,
      ctx({ mainTurnTokens: 60 }),
    );
    expect(actions).toBeNull();
    expect(g.get()?.status).toBe("budget_limited");
  });

  test("formatGoalStatus covers inactive, planning, and checklist progress", () => {
    expect(formatGoalStatus(null)).toContain("No goal is set");
    const g = createGoalGovernor({ evaluate: alwaysNotMet(), now: () => Date.now() - 5000 });
    g.set("ship it", { turnBudget: 12 });
    const planning = formatGoalStatus(g.get());
    expect(planning).toContain("ship it");
    expect(planning).toMatch(/planning|not planned|criteria/i);

    g.setCriteria([
      { id: "c1", title: "typecheck", status: "done" },
      { id: "c2", title: "tests", status: "todo" },
    ]);
    const text = formatGoalStatus(g.get());
    expect(text).toContain("typecheck");
    expect(text).toContain("tests");
    expect(text).toMatch(/1\/2|Progress/i);
  });
});
