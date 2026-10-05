import { describe, expect, test } from "bun:test";
import {
  createDecideTool,
  decideDefinition,
  DECIDE_DEFAULT_TIMEOUT_MS,
  isDecideEnabled,
  type DecideEvaluateResult,
  type DecideEvaluateRequest,
  type DecideEvaluator,
} from "./decide.js";

const neverAbortedSignal = new AbortController().signal;

const routeQuestion = {
  id: "route",
  type: "choice",
  instructions: "DIY, spawn a sub-agent, or call a specialist?",
  criteria: {
    diy: "Tiny bounded edit",
    spawn: "Substantial work for a sub-agent",
    specialist: "Needs a specialist director",
  },
} as const;

function okEvaluator(
  seen: DecideEvaluateRequest[],
  latencyMs = 42,
): DecideEvaluator {
  return async (request) => {
    seen.push(request);
    return {
      ok: true,
      decisions: request.questions.map((question) => ({
        id: question.id,
        type: question.type === "boolean" ? "noul" : question.type,
        ...(question.type === "choice"
          ? { choice: "diy", confidence: 0.9 }
          : { noul: 0.8 }),
      })),
      latencyMs,
    };
  };
}

async function runTool(
  evaluate: DecideEvaluator,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = createDecideTool({ evaluate });
  if (tool.kind !== "string") throw new Error("decide must be a string tool");
  return tool.handler(args, neverAbortedSignal);
}

function validArgs(): Record<string, unknown> {
  return {
    state: { action: "fix-typo", env: "production", approvals: 0 },
    questions: [{ ...routeQuestion }],
  };
}

describe("decide tool", () => {
  test("returns one decision per question with latencyMs in a single call", async () => {
    const seen: DecideEvaluateRequest[] = [];
    const output = await runTool(okEvaluator(seen), {
      state: { action: "fix-typo" },
      questions: [
        { ...routeQuestion },
        {
          id: "escalate",
          type: "boolean",
          instructions: "Must this be escalated for human approval?",
        },
      ],
    });
    const parsed = JSON.parse(output) as {
      fallback: boolean;
      decisions: { id: string }[];
      latencyMs: number;
    };
    expect(parsed.fallback).toBe(false);
    expect(parsed.decisions.map((decision) => decision.id)).toEqual([
      "route",
      "escalate",
    ]);
    expect(typeof parsed.latencyMs).toBe("number");
    expect(parsed.latencyMs).toBeGreaterThanOrEqual(0);
    // One POST carries every question: a single evaluate call with both.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.questions.map((question) => question.id)).toEqual([
      "route",
      "escalate",
    ]);
    expect(seen[0]?.timeoutMs).toBe(DECIDE_DEFAULT_TIMEOUT_MS);
  });

  test.each(["timeout", "network", "http-error", "parse-error"] as const)(
    "fails closed on %s fallback",
    async (reason) => {
      const fallback: DecideEvaluateResult = {
        ok: false,
        fallback: true,
        reason,
        detail: "boom",
        latencyMs: 7,
      };
      const output = await runTool(async () => fallback, validArgs());
      const parsed = JSON.parse(output) as {
        fallback: boolean;
        reason: string;
        latencyMs: number;
        error: string;
      };
      expect(parsed.fallback).toBe(true);
      expect(parsed.reason).toBe(reason);
      expect(parsed.latencyMs).toBe(7);
      expect(parsed.error).toContain("Fail closed");
    },
  );

  test("fails closed with no-key when no API key is configured", async () => {
    const tool = createDecideTool({ env: {} });
    if (tool.kind !== "string") throw new Error("decide must be a string tool");
    const output = await tool.handler(validArgs(), neverAbortedSignal);
    const parsed = JSON.parse(output) as {
      fallback: boolean;
      reason: string;
      error: string;
    };
    expect(parsed.fallback).toBe(true);
    expect(parsed.reason).toBe("no-key");
    expect(parsed.error).toContain("Fail closed");
  });

  test.each([
    ["missing questions", { state: {} }],
    ["empty questions", { state: {}, questions: [] }],
    [
      "duplicate ids",
      {
        state: {},
        questions: [{ ...routeQuestion }, { ...routeQuestion }],
      },
    ],
    [
      "unknown type",
      {
        state: {},
        questions: [{ id: "q", type: "essay", instructions: "Write it up" }],
      },
    ],
    [
      "empty instructions",
      {
        state: {},
        questions: [{ id: "q", type: "noul", instructions: "" }],
      },
    ],
    [
      "choice without criteria",
      {
        state: {},
        questions: [{ id: "q", type: "choice", instructions: "Pick one" }],
      },
    ],
    [
      "score with one level",
      {
        state: {},
        questions: [
          {
            id: "q",
            type: "score",
            instructions: "Rate it",
            criteria: ["only"],
          },
        ],
      },
    ],
  ])("validation rejects %s without calling evaluate", async (_name, args) => {
    let calls = 0;
    const output = await runTool(async () => {
      calls += 1;
      return { ok: true, decisions: [], latencyMs: 0 };
    }, args);
    expect(output).toMatch(/^Error: decide/);
    expect(calls).toBe(0);
  });

  test("does not generate text: structured decisions only", () => {
    expect(decideDefinition.name).toBe("decide");
    expect(decideDefinition.description).toContain("never generates text");
    expect(decideDefinition.description).not.toContain("summar");
  });

  test("success payload is JSON with a decisions array, not prose", async () => {
    const seen: DecideEvaluateRequest[] = [];
    const output = await runTool(okEvaluator(seen), validArgs());
    const parsed = JSON.parse(output) as {
      decisions: unknown[];
    };
    expect(Array.isArray(parsed.decisions)).toBe(true);
    expect(parsed.decisions).toHaveLength(1);
  });
});

describe("decide gating", () => {
  test("off by default", () => {
    expect(isDecideEnabled(undefined)).toBe(false);
    expect(isDecideEnabled({})).toBe(false);
    expect(isDecideEnabled({ decideEnabled: false })).toBe(false);
  });

  test("on only when explicitly enabled", () => {
    expect(isDecideEnabled({ decideEnabled: true })).toBe(true);
  });

  test("toolset omits decide unless enabled", async () => {
    const { createAgentToolset } = await import("../agent/tools.js");
    const { createPermissionGate } = await import("../permission/gate.js");
    const baseArgs = {
      cwd: process.cwd(),
      permissionGate: createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: true,
        reactorGated: false,
      }),
    };
    const off = await createAgentToolset(baseArgs);
    try {
      const names = off.dynamicRunner
        .currentDefinitions()
        .map((def) => def.name);
      expect(names).not.toContain("decide");
    } finally {
      await off.dispose();
    }
    const on = await createAgentToolset({ ...baseArgs, decideEnabled: true });
    try {
      const names = on.dynamicRunner
        .currentDefinitions()
        .map((def) => def.name);
      expect(names).toContain("decide");
    } finally {
      await on.dispose();
    }
  });
});
