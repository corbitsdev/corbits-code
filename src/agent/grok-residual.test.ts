import { describe, expect, it } from "bun:test";
import { GROK_PROMPT_RESIDUAL } from "./model-family-policy.js";
import {
  buildGrokLeafAntiThrashNote,
  buildSubAgentSystemPrompt,
} from "./prompts.js";
import { shouldApplyGrokAntiThrash } from "../subagent/provider-family.js";

// The three Grok ceremony lines (CL-7768 Design, merged by CL-8296): no git,
// no pre-plan, verify once.
const CEREMONY_LINES = [
  "- Never run git add, git commit, git stash, or any other state-changing git command unless the user asks.",
  "- Do not narrate a plan before acting on a small task; act, then report.",
  "- Verify with the test command once at the end, not after every edit.",
] as const;

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("grok ceremony merge (CL-8296)", () => {
  it("exposes a single grok residual with each ceremony line exactly once", () => {
    expect(GROK_PROMPT_RESIDUAL).toContain("Finish bias (xAI / Grok worker):");
    for (const line of CEREMONY_LINES) {
      expect(countOccurrences(GROK_PROMPT_RESIDUAL, line)).toBe(1);
    }
  });

  it("keeps the don't re-read line exactly once — no duplicate", () => {
    expect(
      countOccurrences(GROK_PROMPT_RESIDUAL, "re-open paths you already read"),
    ).toBe(1);
  });

  it("is grok-only: the finish-bias gate fires for grok leaves alone", () => {
    expect(
      shouldApplyGrokAntiThrash({
        providerName: "xai/default",
        model: "grok-4.6",
        orchestrator: false,
      }),
    ).toBe(true);
    for (const input of [
      { providerName: "anthropic", model: "claude-sonnet-4" },
      { providerName: "moonshot", model: "kimi-k2" },
      { providerName: "opencode-go", model: "muse-spark-1.3-contributor" },
      { providerName: "openai", model: "gpt-5.6" },
    ] as const) {
      expect(shouldApplyGrokAntiThrash({ ...input, orchestrator: false })).toBe(
        false,
      );
    }
    expect(
      shouldApplyGrokAntiThrash({
        providerName: "xai/default",
        model: "grok-4.6",
        orchestrator: true,
      }),
    ).toBe(false);
  });

  it("buildGrokLeafAntiThrashNote is the same single residual (one source of truth)", () => {
    expect(buildGrokLeafAntiThrashNote()).toBe(GROK_PROMPT_RESIDUAL);
  });

  it("the assembled grok worker prompt carries the merged residual exactly once", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: false,
      grokAntiThrash: true,
    });
    expect(countOccurrences(prompt, "Finish bias (xAI / Grok worker):")).toBe(
      1,
    );
    for (const line of CEREMONY_LINES) {
      expect(countOccurrences(prompt, line)).toBe(1);
    }
  });
});
