import { describe, expect, test } from "bun:test";
import {
  composePromptActionBarModelLabel,
  yoloModeLabel,
} from "./prompt-action-bar-label.js";

describe("composePromptActionBarModelLabel", () => {
  test("omits profile when unset", () => {
    expect(composePromptActionBarModelLabel({ model: "gpt-5" })).toBe("gpt-5");
  });

  test("includes profile before model and effort when set", () => {
    expect(
      composePromptActionBarModelLabel({
        profile: "work",
        model: "gpt-5",
        effort: "high",
      }),
    ).toBe("work · gpt-5 · high");
  });

  test("omits effort segment when absent or empty", () => {
    expect(
      composePromptActionBarModelLabel({ model: "gpt-5", effort: "" }),
    ).toBe("gpt-5");
    expect(
      composePromptActionBarModelLabel({ profile: "work", model: "gpt-5" }),
    ).toBe("work · gpt-5");
  });

  test("shows profile alone when model and effort are absent", () => {
    expect(composePromptActionBarModelLabel({ profile: "work" })).toBe("work");
  });

  test("omits empty model segment", () => {
    expect(
      composePromptActionBarModelLabel({
        profile: "work",
        model: "",
        effort: "high",
      }),
    ).toBe("work · high");
  });

  test("returns undefined when no segments apply", () => {
    expect(composePromptActionBarModelLabel({})).toBeUndefined();
    expect(composePromptActionBarModelLabel({ profile: "" })).toBeUndefined();
    expect(composePromptActionBarModelLabel({ model: "" })).toBeUndefined();
  });

  test("appends a permission mode segment when set", () => {
    expect(
      composePromptActionBarModelLabel({ model: "gpt-5", mode: "yolo" }),
    ).toBe("gpt-5 · yolo");
    expect(
      composePromptActionBarModelLabel({
        profile: "work",
        model: "gpt-5",
        effort: "high",
        mode: "yolo",
      }),
    ).toBe("work · gpt-5 · high · yolo");
  });

  test("omits an empty permission mode segment", () => {
    expect(composePromptActionBarModelLabel({ model: "gpt-5", mode: "" })).toBe(
      "gpt-5",
    );
    expect(composePromptActionBarModelLabel({ mode: "yolo" })).toBe("yolo");
  });
});

describe("yoloModeLabel", () => {
  test("returns the yolo segment while permission prompts are skipped", () => {
    expect(yoloModeLabel(true)).toBe("yolo");
  });

  test("returns undefined otherwise so the segment omits", () => {
    expect(yoloModeLabel(false)).toBeUndefined();
  });
});
