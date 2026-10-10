import { describe, expect, test } from "bun:test";

import type { OperatorGateEvent } from "./gate-events.js";
import { PRIMARY_ASK_OPERATOR_SOURCE } from "./gate-events.js";
import {
  addOperatorInputRequired,
  composeOperatorInputRequiredLine,
  NO_OPERATOR_INPUT_REQUIRED,
  operatorInputRequiredMoreCount,
  removeOperatorInputRequired,
} from "./operator-input-required.js";
import { stringWidth } from "./view/height.js";

function gate(
  id: string,
  question = "Which option should I choose?",
): OperatorGateEvent {
  return {
    id,
    source: PRIMARY_ASK_OPERATOR_SOURCE,
    question,
    options: ["one"],
    resolve: () => undefined,
  };
}

function text(
  parts: ReturnType<typeof composeOperatorInputRequiredLine>,
): string {
  return parts.map((part) => part.text).join("");
}

describe("operator input required view model", () => {
  test("is inactive when empty", () => {
    expect(
      composeOperatorInputRequiredLine(NO_OPERATOR_INPUT_REQUIRED, 80),
    ).toEqual([]);
  });

  test("admits marked primary gates once by id and keeps a duplicate as a no-op", () => {
    const first = addOperatorInputRequired(
      NO_OPERATOR_INPUT_REQUIRED,
      gate("one"),
    );
    const again = addOperatorInputRequired(first, gate("one"));
    expect(first.items).toHaveLength(1);
    expect(again).toBe(first);
    expect(text(composeOperatorInputRequiredLine(first, 100))).toContain(
      "INPUT REQUIRED",
    );
  });

  test("fails closed for unmarked, foreign-shaped, and empty ids", () => {
    const unmarked = { ...gate("one") };
    delete unmarked.source;
    expect(addOperatorInputRequired(NO_OPERATOR_INPUT_REQUIRED, unmarked)).toBe(
      NO_OPERATOR_INPUT_REQUIRED,
    );
    expect(addOperatorInputRequired(NO_OPERATOR_INPUT_REQUIRED, gate(""))).toBe(
      NO_OPERATOR_INPUT_REQUIRED,
    );
    const permissionLike = {
      id: "permission",
      request: { tool: "run_shell" },
      resolve: () => undefined,
    } as unknown as OperatorGateEvent;
    expect(
      addOperatorInputRequired(NO_OPERATOR_INPUT_REQUIRED, permissionLike),
    ).toBe(NO_OPERATOR_INPUT_REQUIRED);
  });

  test("keeps insertion selection and removes exactly the settled id", () => {
    const first = addOperatorInputRequired(
      NO_OPERATOR_INPUT_REQUIRED,
      gate("one"),
    );
    const both = addOperatorInputRequired(
      first,
      gate("two", "Second question"),
    );
    expect(operatorInputRequiredMoreCount(both)).toBe(1);
    expect(text(composeOperatorInputRequiredLine(both, 100))).toContain(
      "(+1 more)",
    );
    const afterSecond = removeOperatorInputRequired(both, "two");
    expect(afterSecond.items.map((item) => item.id)).toEqual(["one"]);
    const afterFirst = removeOperatorInputRequired(afterSecond, "one");
    expect(afterFirst).toBe(NO_OPERATOR_INPUT_REQUIRED);
    expect(removeOperatorInputRequired(afterFirst, "one")).toBe(afterFirst);
  });

  test("updates a repeated id without changing insertion order and falls back after selection settles", () => {
    const first = addOperatorInputRequired(
      NO_OPERATOR_INPUT_REQUIRED,
      gate("one"),
    );
    const both = addOperatorInputRequired(
      first,
      gate("two", "Second question"),
    );
    const updated = addOperatorInputRequired(
      both,
      gate("one", "Updated question"),
    );
    expect(updated.items.map((item) => item.id)).toEqual(["one", "two"]);
    expect(updated.selectedId).toBe("one");
    const fallback = removeOperatorInputRequired(updated, "one");
    expect(fallback.selectedId).toBe("two");
    expect(removeOperatorInputRequired(fallback, "missing")).toBe(fallback);
  });

  test("sanitizes question previews and stays within every row width", () => {
    const state = addOperatorInputRequired(
      NO_OPERATOR_INPUT_REQUIRED,
      gate("one", "line one\n\u001b[31mline two"),
    );
    for (let cells = 1; cells <= 120; cells++) {
      const line = text(composeOperatorInputRequiredLine(state, cells));
      expect(stringWidth(line)).toBeLessThanOrEqual(cells);
      expect(line).not.toContain("\n");
      expect(line).not.toContain("\u001b");
    }
  });
});
