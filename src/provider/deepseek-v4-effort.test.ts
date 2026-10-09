import { describe, test, expect } from "bun:test";
import {
  DEEPSEEK_V4_EFFORTS,
  DEEPSEEK_V4_MODEL_CARD,
  isDeepSeekV4Model,
  mapV4Effort,
  V4_STREAM_OPTIONS,
  v4Thinking,
} from "./deepseek-v4-effort.js";

describe("isDeepSeekV4Model", () => {
  test.each([
    "deepseek-v4",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-v4.1-flash",
    "deepseek-v4-flash-vision-exp",
    "deepseek-ai/DeepSeek-V4-Flash-0731",
    "deepseek-ai/deepseek-v4-flash",
  ])("true for V4 id %s", (model) => {
    expect(isDeepSeekV4Model(model)).toBe(true);
  });
  test.each([
    "deepseek-v3",
    "deepseek-r1",
    "deepseek-coder",
    "deepseek-chat",
    "gpt-5",
    "kimi-k2",
    "claude-sonnet-4.5",
    "glm-5.3",
    "grok-4.6",
    "some-proxy-deepseek-v4-pro",
  ])("false for non-V4 id %s", (model) => {
    expect(isDeepSeekV4Model(model)).toBe(false);
  });
});

describe("DEEPSEEK_V4_EFFORTS", () => {
  test("ladder is none/xhigh/max", () => {
    expect(DEEPSEEK_V4_EFFORTS).toEqual(["none", "xhigh", "max"]);
  });
});

describe("mapV4Effort", () => {
  test.each([
    ["xhigh", "xhigh"],
    ["max", "max"],
  ] as const)("maps %s raw to %s", (effort, wire) => {
    expect(mapV4Effort(effort)).toBe(wire);
  });
  test("maps none to null (drop the wire effort)", () => {
    expect(mapV4Effort("none")).toBeNull();
  });
  test.each(["low", "medium", "high", "ultra", "minimal"] as const)(
    "leaves off-ladder %s untouched (undefined)",
    (effort) => {
      expect(mapV4Effort(effort)).toBeUndefined();
    },
  );
});

describe("v4Thinking", () => {
  test("thinking off for none", () => {
    expect(v4Thinking("none")).toEqual({ thinking: false });
  });
  test.each(["xhigh", "max"] as const)("thinking on for %s", (effort) => {
    expect(v4Thinking(effort)).toEqual({ thinking: true });
  });
});

describe("DEEPSEEK_V4_MODEL_CARD", () => {
  test("defaults both temperature 1.0 and top_p 0.95", () => {
    expect(DEEPSEEK_V4_MODEL_CARD).toEqual({ temperature: 1.0, topP: 0.95 });
  });
});

describe("V4_STREAM_OPTIONS", () => {
  test("requests include_usage on stream chunks", () => {
    expect(V4_STREAM_OPTIONS).toEqual({
      stream_options: { include_usage: true },
    });
  });
});
