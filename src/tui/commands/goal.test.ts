import { describe, expect, test } from "bun:test";
import { parseGoalArgs } from "./built-in.js";
import { getCommand } from "./registry.js";
import type { CommandContext } from "./registry.js";
import type { GoalSnapshot } from "../../agent/goal.js";
import "./built-in.js";

function snap(partial: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    status: "active",
    condition: "tests green",
    startedAt: Date.now() - 60_000,
    turnBudget: 25,
    turnsUsed: 0,
    mainTokens: 0,
    evalTokens: 0,
    consecutiveEvalFailures: 0,
    consecutiveEmptyYields: 0,
    ...partial,
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

  test("condition with budgets", () => {
    const p = parseGoalArgs("--turns 10 --tokens 5000 all tests pass");
    expect(p.condition).toBe("all tests pass");
    expect(p.opts).toEqual({ turnBudget: 10, tokenBudget: 5000 });
  });

  test("replace flag", () => {
    const p = parseGoalArgs("--replace --turns 5 new condition");
    expect(p.condition).toBe("new condition");
    expect(p.replace).toBe(true);
    expect(p.opts).toEqual({ turnBudget: 5 });
  });
});

describe("/goal command", () => {
  test("set kicks off and reports", () => {
    let setCond = "";
    let kicked = "";
    const ctx: CommandContext = {
      signalClear: () => {},
      goal: {
        get: () => null,
        set: (c) => {
          setCond = c;
          return snap({ condition: c });
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
    const result = cmd!.handler("ship the feature", ctx);
    expect(result.type).toBe("message");
    if (result.type === "message") {
      expect(result.text).toContain("Goal set");
      expect(result.text).toContain("ship the feature");
    }
    expect(setCond).toBe("ship the feature");
    expect(kicked).toBe("ship the feature");
  });

  test("status uses formatGoalStatus", () => {
    const ctx: CommandContext = {
      signalClear: () => {},
      goal: {
        get: () => snap({ lastReason: "still red" }),
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
    }
  });

  test("replace requires --replace when a goal is active", () => {
    const ctx: CommandContext = {
      signalClear: () => {},
      goal: {
        get: () => snap({ condition: "old" }),
        set: (c) => snap({ condition: c }),
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
