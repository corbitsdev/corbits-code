import { describe, expect, test } from "bun:test";

import { resolveSessionMode, sessionModeEnablesSubAgents } from "./session-mode.js";

describe("resolveSessionMode", () => {
  test("local overrides global", () => {
    expect(
      resolveSessionMode({ providers: {}, sessionMode: "orchestrator" }, { sessionMode: "single" }),
    ).toBe("single");
  });

  test("falls back to global when local unset", () => {
    expect(resolveSessionMode({ providers: {}, sessionMode: "single" }, null)).toBe("single");
  });

  test("returns undefined when neither file sets mode", () => {
    expect(resolveSessionMode({ providers: {} }, null)).toBeUndefined();
  });
});

describe("sessionModeEnablesSubAgents", () => {
  test("orchestrator enables sub-agents; single does not", () => {
    expect(sessionModeEnablesSubAgents("orchestrator")).toBe(true);
    expect(sessionModeEnablesSubAgents("single")).toBe(false);
  });
});