import { describe, expect, test } from "bun:test";
import {
  INTENT_WRITE_TOOLS,
  resolveIntentDefaults,
  type TaskIntent,
} from "./intent-defaults.js";

describe("resolveIntentDefaults", () => {
  test("omit and general leave full-toolset / settings behavior", () => {
    expect(resolveIntentDefaults(undefined)).toEqual({});
    expect(resolveIntentDefaults("general")).toEqual({});
  });

  test("explore excludes writes, soft tier fast, maxTurns 20", () => {
    const d = resolveIntentDefaults("explore");
    expect(d.capabilities).toEqual({
      mode: "exclude",
      tools: [...INTENT_WRITE_TOOLS],
    });
    expect(d.tier).toBe("fast");
    expect(d.maxTurns).toBe(20);
  });

  test("review excludes writes, soft tier standard, maxTurns 25", () => {
    const d = resolveIntentDefaults("review");
    expect(d.capabilities?.mode).toBe("exclude");
    expect(d.capabilities?.tools).toEqual([...INTENT_WRITE_TOOLS]);
    expect(d.tier).toBe("standard");
    expect(d.maxTurns).toBe(25);
  });

  test("plan excludes writes, soft tier clever, maxTurns 25", () => {
    const d = resolveIntentDefaults("plan");
    expect(d.capabilities?.tools).toContain("write_file");
    expect(d.tier).toBe("clever");
    expect(d.maxTurns).toBe(25);
  });

  test("implement raises maxTurns only (full toolset)", () => {
    const d = resolveIntentDefaults("implement");
    expect(d.capabilities).toBeUndefined();
    expect(d.tier).toBeUndefined();
    expect(d.maxTurns).toBe(50);
  });

  test("every TaskIntent is handled", () => {
    const intents: TaskIntent[] = ["explore", "implement", "review", "plan", "general"];
    for (const intent of intents) {
      expect(() => resolveIntentDefaults(intent)).not.toThrow();
    }
  });
});
