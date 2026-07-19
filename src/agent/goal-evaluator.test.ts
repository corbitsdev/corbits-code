import { describe, expect, test } from "bun:test";
import type { ConversationTurn, InferenceSource } from "@intx/types/runtime";
import { createGoalEvaluator, evidenceFromTurns } from "./goal-evaluator.js";

const source: InferenceSource = {
  provider: "test",
  model: "test-model",
} as InferenceSource;

describe("createGoalEvaluator", () => {
  test("returns error verdict when no source is configured", async () => {
    const evaluate = createGoalEvaluator({ getSource: () => undefined });
    const v = await evaluate({ condition: "tests pass", evidence: "ok" });
    expect(v.met).toBe(false);
    expect(v.error).toBe(true);
    expect(v.reason).toContain("No evaluator model");
  });

  test("returns not-met when evidence is empty", async () => {
    const evaluate = createGoalEvaluator({
      getSource: () => source,
      complete: async () => {
        throw new Error("should not be called");
      },
    });
    const v = await evaluate({ condition: "x", evidence: "   " });
    expect(v.met).toBe(false);
    expect(v.error).toBeUndefined();
    expect(v.reason).toContain("No evidence");
  });

  test("parses a clean JSON verdict", async () => {
    const evaluate = createGoalEvaluator({
      getSource: () => source,
      complete: async () => ({
        text: '{"met": true, "reason": "all unit tests green"}',
        evalTokens: 42,
      }),
    });
    const v = await evaluate({ condition: "tests green", evidence: "bun test: 10 pass" });
    expect(v).toEqual({ met: true, reason: "all unit tests green", evalTokens: 42 });
  });

  test("parses JSON embedded in prose", async () => {
    const evaluate = createGoalEvaluator({
      getSource: () => source,
      complete: async () => ({
        text: 'Here is my decision:\n{"met": false, "reason": "build still failing"}\nThanks.',
        evalTokens: 10,
      }),
    });
    const v = await evaluate({ condition: "build passes", evidence: "error TS" });
    expect(v.met).toBe(false);
    expect(v.reason).toBe("build still failing");
  });

  test("fail-open on model call failure", async () => {
    const evaluate = createGoalEvaluator({
      getSource: () => source,
      complete: async () => {
        throw new Error("network down");
      },
    });
    const v = await evaluate({ condition: "x", evidence: "y" });
    expect(v.met).toBe(false);
    expect(v.error).toBe(true);
    expect(v.reason).toContain("network down");
  });

  test("fail-open on invalid schema", async () => {
    const evaluate = createGoalEvaluator({
      getSource: () => source,
      complete: async () => ({ text: '{"ok": true}', evalTokens: 1 }),
    });
    const v = await evaluate({ condition: "x", evidence: "y" });
    expect(v.met).toBe(false);
    expect(v.error).toBe(true);
    expect(v.reason).toContain("schema");
  });
});

describe("evidenceFromTurns", () => {
  test("summarizes recent user and assistant text and tool calls", () => {
    const turns: ConversationTurn[] = [
      {
        role: "user",
        content: [{ type: "text", text: "fix the bug" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll edit the file" },
          { type: "tool_call", id: "1", name: "edit_file", arguments: { path: "a.ts" } },
        ],
        timestamp: 2,
      },
    ];
    const evidence = evidenceFromTurns(turns);
    expect(evidence).toContain("fix the bug");
    expect(evidence).toContain("edit_file");
    expect(evidence).toContain("a.ts");
  });
});
