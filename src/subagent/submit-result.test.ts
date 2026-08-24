import { describe, expect, test } from "bun:test";

import { createSubmitResultState, evaluateSubmitResult } from "./submit-result.js";

const TOKEN = "turn-abc123";

describe("evaluateSubmitResult", () => {
  test("a valid submission against a declared schema succeeds", () => {
    const state = createSubmitResultState();
    const outcome = evaluateSubmitResult({
      turnToken: TOKEN,
      submittedToken: TOKEN,
      result: { verdict: "pass", score: 5 },
      schema: {
        type: "object",
        required: ["verdict", "score"],
        properties: {
          verdict: { type: "string", enum: ["pass", "fail"] },
          score: { type: "number", minimum: 0, maximum: 10 },
        },
      },
      state,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toBe("Result accepted.");
    expect(state.corrections).toBe(0);
  });

  test("an invalid submission returns a correction and a resubmit then succeeds", () => {
    const state = createSubmitResultState();
    const schema = {
      type: "object" as const,
      required: ["verdict"],
      properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
    };

    const first = evaluateSubmitResult({
      turnToken: TOKEN,
      submittedToken: TOKEN,
      result: { verdict: "maybe" },
      schema,
      state,
    });
    expect(first.ok).toBe(false);
    expect(first.message).toContain("Invalid submission");
    expect(state.corrections).toBe(1);

    const second = evaluateSubmitResult({
      turnToken: TOKEN,
      submittedToken: TOKEN,
      result: { verdict: "pass" },
      schema,
      state,
    });
    expect(second.ok).toBe(true);
    expect(second.message).toBe("Result accepted.");
  });

  test("a stale/mismatched turn token is rejected", () => {
    const state = createSubmitResultState();
    const outcome = evaluateSubmitResult({
      turnToken: TOKEN,
      submittedToken: "some-other-turn-token",
      result: { verdict: "pass" },
      state,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("turn_token does not match");
    expect(state.corrections).toBe(0);
  });

  test("correction cap refuses further attempts once reached", () => {
    const state = createSubmitResultState();
    const schema = { type: "object" as const, required: ["x"] };
    for (let i = 0; i < 3; i++) {
      evaluateSubmitResult({
        turnToken: TOKEN,
        submittedToken: TOKEN,
        result: {},
        schema,
        state,
      });
    }
    const capped = evaluateSubmitResult({
      turnToken: TOKEN,
      submittedToken: TOKEN,
      result: { x: 1 },
      schema,
      state,
    });
    expect(capped.ok).toBe(false);
    expect(capped.message).toContain("correction cap");
  });
});
