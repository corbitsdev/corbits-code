import { describe, expect, test } from "bun:test";
import { parseGoalArgs } from "./built-in.js";
import { getCommand } from "./registry.js";
import type { CommandContext } from "./registry.js";
import type { GoalSnapshot } from "../../agent/goal.js";
import "./built-in.js";

function snap(partial: Partial<GoalSnapshot> = {}): GoalSnapshot {
  const condition = partial.condition ?? "tests green";
  const criteria = partial.criteria ?? [];
  const status = partial.status ?? "active";
  return {
    status,
    phase: partial.phase ?? (criteria.length === 0 ? "planning" : "implementing"),
    condition,
    brief: partial.brief ?? condition,
    criteria,
    startedAt: partial.startedAt ?? Date.now() - 60_000,
    turnBudget: partial.turnBudget ?? 0,
    turnsUsed: partial.turnsUsed ?? 0,
    mainTokens: partial.mainTokens ?? 0,
    evalTokens: partial.evalTokens ?? 0,
    consecutiveEvalFailures: partial.consecutiveEvalFailures ?? 0,
    consecutiveEmptyYields: partial.consecutiveEmptyYields ?? 0,
    ...(partial.tokenBudget !== undefined ? { tokenBudget: partial.tokenBudget } : {}),
    ...(partial.lastReason !== undefined ? { lastReason: partial.lastReason } : {}),
  };
}

describe("parseGoalArgs", () => {
  test("empty is status", () => {
    expect(parseGoalArgs("")).toEqual({ sub: "status" });
  });

  test("pause resume clear aliases", () => {
    expect(parseGoalArgs("pause").sub).toBe("pause");
    expect(parseGoalArgs("resume").sub).toBe("resume");
    expect(parseGoalArgs("clear").sub).toBe("clear");
    expect(parseGoalArgs("stop").sub).toBe("clear");
    expect(parseGoalArgs("off").sub).toBe("clear");
  });

  test("condition alone uses default budget (turns fully optional)", () => {
    const p = parseGoalArgs("all tests pass");
    expect(p.condition).toBe("all tests pass");
    expect(p.opts).toBeUndefined();
  });

  test("leading integer is optional turn budget", () => {
    const p = parseGoalArgs("10 all tests pass");
    expect(p.condition).toBe("all tests pass");
    expect(p.opts).toEqual({ turnBudget: 10 });
  });

  test("leading turns with --tokens", () => {
    const p = parseGoalArgs("10 --tokens 5000 all tests pass");
    expect(p.condition).toBe("all tests pass");
    expect(p.opts).toEqual({ turnBudget: 10, tokenBudget: 5000 });
  });

  test("legacy --turns still accepted", () => {
    const p = parseGoalArgs("--turns 10 --tokens 5000 all tests pass");
    expect(p.condition).toBe("all tests pass");
    expect(p.opts).toEqual({ turnBudget: 10, tokenBudget: 5000 });
  });

  test("replace flag", () => {
    const p = parseGoalArgs("--replace new condition");
    expect(p.condition).toBe("new condition");
    expect(p.replace).toBe(true);
    expect(p.opts).toBeUndefined();
  });

  test("replace with leading turns", () => {
    const p = parseGoalArgs("5 --replace new condition");
    expect(p.condition).toBe("new condition");
    expect(p.replace).toBe(true);
    expect(p.opts).toEqual({ turnBudget: 5 });
  });
});

describe("/goal command", () => {
  test("set kicks off and reports brief", () => {
    let setCond = "";
    let kicked = "";
    let setOpts: unknown;
    const ctx: CommandContext = {
      signalClear: () => {},
      goal: {
        get: () => null,
        set: (c, opts) => {
          setCond = c;
          setOpts = opts;
          return snap({ condition: c, brief: c, turnBudget: opts?.turnBudget ?? 0 });
        },
        pause: () => null,
        resume: () => null,
        clear: () => {},
        kickoff: (c) => {
          kicked = c;
        },
      },
    };
    const cmd = getCommand("goal");
    expect(cmd).toBeDefined();
    expect(cmd!.argumentHint).toBe("[turns] <brief>");

    const result = cmd!.handler("ship the feature", ctx);
    expect(result.type).toBe("message");
    if (result.type === "message") {
      expect(result.text).toContain("Goal set");
      expect(result.text).toContain("ship the feature");
      expect(result.text).not.toContain("The agent will expand");
      expect(result.text).not.toContain("manage_goal");
    }
    expect(setCond).toBe("ship the feature");
    expect(setOpts).toBeUndefined();
    expect(kicked).toBe("ship the feature");
  });

  test("set with leading turn budget", () => {
    let setOpts: { turnBudget?: number } | undefined;
    const ctx: CommandContext = {
      signalClear: () => {},
      goal: {
        get: () => null,
        set: (c, opts) => {
          setOpts = opts;
          return snap({ condition: c, brief: c, turnBudget: opts?.turnBudget ?? 0 });
        },
        pause: () => null,
        resume: () => null,
        clear: () => {},
        kickoff: () => {},
      },
    };
    const result = getCommand("goal")!.handler("12 ship the feature", ctx);
    expect(result.type).toBe("message");
    expect(setOpts).toEqual({ turnBudget: 12 });
  });

  test("status uses formatGoalStatus", () => {
    const ctx: CommandContext = {
      signalClear: () => {},
      goal: {
        get: () =>
          snap({
            lastReason: "still red",
            criteria: [
              { id: "c1", title: "typecheck clean", status: "done" },
              { id: "c2", title: "tests green", status: "todo" },
            ],
          }),
        set: () => snap(),
        pause: () => null,
        resume: () => null,
        clear: () => {},
      },
    };
    const result = getCommand("goal")!.handler("", ctx);
    expect(result.type).toBe("message");
    if (result.type === "message") {
      expect(result.text).toContain("tests green");
      expect(result.text).toContain("still red");
      expect(result.text).toContain("typecheck clean");
    }
  });

  test("replace requires --replace when a goal is active", () => {
    const ctx: CommandContext = {
      signalClear: () => {},
      goal: {
        get: () => snap({ condition: "old", brief: "old" }),
        set: (c) => snap({ condition: c, brief: c }),
        pause: () => null,
        resume: () => null,
        clear: () => {},
        kickoff: () => {},
      },
    };
    const blocked = getCommand("goal")!.handler("new goal", ctx);
    expect(blocked.type).toBe("message");
    if (blocked.type === "message") {
      expect(blocked.text).toContain("--replace");
    }
    const ok = getCommand("goal")!.handler("--replace new goal", ctx);
    expect(ok.type).toBe("message");
    if (ok.type === "message") {
      expect(ok.text).toContain("Goal set");
      expect(ok.text).toContain("new goal");
    }
  });
});
