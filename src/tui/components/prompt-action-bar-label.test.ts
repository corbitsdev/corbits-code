import { describe, expect, test } from "bun:test";
import { composePromptActionBarModelLabel } from "./prompt-action-bar-label.js";

describe("composePromptActionBarModelLabel", () => {
  test("omits profile when unset", () => {
    expect(composePromptActionBarModelLabel({ model: "gpt-5" })).toBe("gpt-5");
  });

  test("includes profile before model and effort when set", () => {
    expect(
      composePromptActionBarModelLabel({ profile: "work", model: "gpt-5", effort: "high" }),
    ).toBe("work · gpt-5 · high");
  });

  test("omits effort segment when absent or empty", () => {
    expect(composePromptActionBarModelLabel({ model: "gpt-5", effort: "" })).toBe("gpt-5");
    expect(composePromptActionBarModelLabel({ profile: "work", model: "gpt-5" })).toBe(
      "work · gpt-5",
    );
  });

  test("returns undefined when no segments apply", () => {
    expect(composePromptActionBarModelLabel({})).toBeUndefined();
    expect(composePromptActionBarModelLabel({ profile: "" })).toBeUndefined();
  });
});