import { describe, expect, test } from "bun:test";
import { CodexAuthError } from "../auth/codex/session.js";
import { XaiAuthError } from "../auth/xai/session.js";
import {
  classifySubAgentInferenceAuthFailure,
  formatSubAgentSpawnAuthFailureMessage,
} from "./inference-auth-failure.js";

describe("sub-agent inference auth failures", () => {
  test("classifies Codex and xAI auth errors", () => {
    expect(
      classifySubAgentInferenceAuthFailure(new CodexAuthError("work", "refresh-failed", "expired")),
    ).toBe("codex");
    expect(
      classifySubAgentInferenceAuthFailure(new XaiAuthError("default", "refresh-failed", "401")),
    ).toBe("xai");
    expect(classifySubAgentInferenceAuthFailure(new Error("nope"))).toBeNull();
  });

  test("formats actionable spawn_agent error with profile and re-login hint", () => {
    const msg = formatSubAgentSpawnAuthFailureMessage(
      "explore auth",
      new CodexAuthError("work", "refresh-failed", "Token refresh failed"),
    );
    expect(msg).toContain('sub-agent "explore auth"');
    expect(msg).toContain('profile "work"');
    expect(msg).toContain("Re-authenticate");
    // SessionStore.fail prefixes "Error: "; the message itself must not.
    expect(msg?.startsWith("Error:")).toBe(false);
  });
});
