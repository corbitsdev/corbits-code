import { describe, expect, test } from "bun:test";
import type { ReactorAction, ReactorCapabilities } from "@intx/types/runtime";
import {
  createGoalGovernor,
  formatGoalStatus,
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

describe("goal governor state machine", () => {
  test("set activates and replace resets counters", () => {
    const g = createGoalGovernor({ evaluate: alwaysNotMet(), now: () => 1000 });
    expect(g.get()).toBeNull();

    const first = g.set("all tests green", { turnBudget: 10 });
    expect(first.status).toBe("active");
    expect(first.condition).toBe("all tests green");
    expect(first.turnBudget).toBe(10);
    expect(first.startedAt).toBe(1000);

    const second = g.set("ship the feature");
    expect(second.condition).toBe("ship the feature");
    expect(second.turnsUsed).toBe(0);
    expect(second.status).toBe("active");
  });

  test("pause and resume extend the turn budget", () => {
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

  test("clear returns to inactive", () => {
    const g = createGoalGovernor({ evaluate: alwaysNotMet() });
    g.set("x");
    g.clear();
    expect(g.get()).toBeNull();
  });

  test("restore turns active into paused and drops cleared", () => {
    const g = createGoalGovernor({ evaluate: alwaysNotMet() });
    const paused = g.restore({
      status: "active",
      condition: "migrate auth",
      startedAt: 50,
      turnBudget: 25,
      turnsUsed: 3,
    });
    expect(paused?.status).toBe("paused");
    expect(paused?.condition).toBe("migrate auth");
    expect(paused?.turnsUsed).toBe(3);

    g.restore({ status: "cleared", condition: "old", startedAt: 1, turnBudget: 5 });
    expect(g.get()).toBeNull();
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

  test("not-met rewrites wait into re-infer with ephemeral nudge", async () => {
    const g = createGoalGovernor({ evaluate: alwaysNotMet("still failing") });
    g.set("tests green");
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
    expect(nudgeText).toContain("still failing");
    expect(g.get()?.status).toBe("active");
    expect(g.get()?.turnsUsed).toBe(1);
    expect(g.get()?.lastReason).toBe("still failing");
  });

  test("met yields terminal actions unchanged and marks achieved", async () => {
    const g = createGoalGovernor({ evaluate: alwaysMet("all green") });
    g.set("tests green");
    const actions = await g.interceptTerminal(replyTerminal, capabilities, ctx());
    expect(actions).toBeNull();
    expect(g.get()?.status).toBe("achieved");
    expect(g.get()?.lastReason).toBe("all green");
  });

  test("fail-open treats evaluator errors as not-met", async () => {
    const g = createGoalGovernor({
      evaluate: failingEval("boom"),
      maxConsecutiveEvalFailures: 3,
    });
    g.set("x");
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
    expect((await g.interceptTerminal(waitTerminal, capabilities, ctx()))?.some((a) => a.type === "infer")).toBe(
      true,
    );
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
    const first = await g.interceptTerminal(waitTerminal, capabilities, ctx());
    expect(first?.some((a) => a.type === "infer")).toBe(true);
    expect(g.get()?.turnsUsed).toBe(1);
    expect(g.get()?.status).toBe("active");

    const second = await g.interceptTerminal(waitTerminal, capabilities, ctx());
    expect(second).toBeNull();
    expect(g.get()?.status).toBe("budget_limited");
    expect(g.get()?.lastReason).toContain("Turn budget");
  });

  test("token budget soft-stops when main+eval exceed the cap", async () => {
    const g = createGoalGovernor({
      evaluate: async () => ({ met: false, reason: "no", evalTokens: 50 }),
    });
    g.set("x", { tokenBudget: 100 });
    const actions = await g.interceptTerminal(
      waitTerminal,
      capabilities,
      ctx({ mainTurnTokens: 60 }),
    );
    expect(actions).toBeNull();
    expect(g.get()?.status).toBe("budget_limited");
  });

  test("formatGoalStatus covers inactive and active", () => {
    expect(formatGoalStatus(null)).toContain("No goal is set");
    const g = createGoalGovernor({ evaluate: alwaysNotMet(), now: () => Date.now() - 5000 });
    g.set("ship it", { turnBudget: 12 });
    const text = formatGoalStatus(g.get());
    expect(text).toContain("ship it");
    expect(text).toContain("active");
    expect(text).toContain("Turns:");
  });
});
