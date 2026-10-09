import { describe, test, expect } from "bun:test";
import {
  DEEPSEEK_V4_EFFORTS,
  DEEPSEEK_V4_MODEL_CARD,
  DEEPSEEK_V4_ROLE_EFFORT,
  isDeepSeekModel,
  isDeepSeekV4Model,
  mapV4Effort,
  V4_STREAM_OPTIONS,
  v4Thinking,
} from "./deepseek-v4-effort.js";

describe("isDeepSeekModel", () => {
  test.each([
    "deepseek-v4",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-v4.1-flash",
    "deepseek-v4-flash-vision-exp",
    "deepseek-ai/DeepSeek-V4-Flash-0731",
    "deepseek-ai/deepseek-v4-flash",
    "deepseek-v3",
    "deepseek-r1",
    "deepseek-coder",
    "deepseek-chat",
    "deepseek-ai/DeepSeek-Chat",
  ])("true for deepseek family id %s", (model) => {
    expect(isDeepSeekModel(model)).toBe(true);
  });
  test.each([
    "gpt-5",
    "kimi-k2",
    "claude-sonnet-4.5",
    "glm-5.3",
    "grok-4.6",
    "some-proxy-deepseek-pro",
  ])("false for non-deepseek id %s", (model) => {
    expect(isDeepSeekModel(model)).toBe(false);
  });
});

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
    "deepseek-ai/DeepSeek-Chat",
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

describe("DEEPSEEK_V4_ROLE_EFFORT", () => {
  test("coder defaults to max", () => {
    expect(DEEPSEEK_V4_ROLE_EFFORT.coder).toBe("max");
  });
  test("dispatch/planner/reviewer are max and other leaves xhigh", () => {
    expect(DEEPSEEK_V4_ROLE_EFFORT.dispatch).toBe("max");
    expect(DEEPSEEK_V4_ROLE_EFFORT.planner).toBe("max");
    expect(DEEPSEEK_V4_ROLE_EFFORT.reviewer).toBe("max");
    for (const role of [
      "explorer",
      "artist",
      "qa-lead",
      "prober",
      "designer",
      "shakespeare",
      "warden",
    ] as const) {
      expect(DEEPSEEK_V4_ROLE_EFFORT[role]).toBe("xhigh");
    }
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
    "rejects off-ladder %s with a clear error (no pass-through)",
    (effort) => {
      expect(() => mapV4Effort(effort)).toThrow(
        `DeepSeek V4 does not support reasoning effort "${effort}"`,
      );
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
