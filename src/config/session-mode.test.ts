import { describe, expect, test } from "bun:test";

import { isSessionMode, resolveSessionMode, sessionModeEnablesSubAgents } from "./session-mode.js";

describe("resolveSessionMode", () => {
  test("always returns orchestrator regardless of settings", () => {
    expect(
      resolveSessionMode(
        { providers: {}, sessionMode: "orchestrator" },
        { sessionMode: "single" as never },
      ),
    ).toBe("orchestrator");
    expect(resolveSessionMode({ providers: {}, sessionMode: "single" as never }, null)).toBe(
      "orchestrator",
    );
    expect(resolveSessionMode({ providers: {} }, null)).toBe("orchestrator");
  });
});

describe("sessionModeEnablesSubAgents", () => {
  test("always enables sub-agents", () => {
    expect(sessionModeEnablesSubAgents("orchestrator")).toBe(true);
    expect(sessionModeEnablesSubAgents()).toBe(true);
  });
});

describe("isSessionMode", () => {
  test("accepts orchestrator only", () => {
    expect(isSessionMode("orchestrator")).toBe(true);
    expect(isSessionMode("single")).toBe(false);
    expect(isSessionMode("fleet")).toBe(false);
  });
});
