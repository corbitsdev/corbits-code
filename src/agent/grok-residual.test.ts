import { describe, expect, it } from "bun:test";
import { promptResidual } from "./model-family-policy.js";
import {
  buildGrokLeafAntiThrashNote,
  buildSubAgentSystemPrompt,
} from "./prompts.js";

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
    const residual = promptResidual("grok");
    expect(residual).toContain("Finish bias (xAI / Grok worker):");
    for (const line of CEREMONY_LINES) {
      expect(countOccurrences(residual, line)).toBe(1);
    }
  });

  it("keeps the don't re-read line exactly once — no duplicate", () => {
    const residual = promptResidual("grok");
    expect(countOccurrences(residual, "re-open paths you already read")).toBe(
      1,
    );
  });

  it("is grok-only: every other family resolves to an empty residual", () => {
    expect(promptResidual("default")).toBe("");
    expect(promptResidual("kimi")).toBe("");
    expect(promptResidual("muse")).toBe("");
  });

  it("buildGrokLeafAntiThrashNote is the same single residual (one source of truth)", () => {
    expect(buildGrokLeafAntiThrashNote()).toBe(promptResidual("grok"));
  });

  it("the assembled grok worker prompt carries the merged residual exactly once", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: false,
      grokAntiThrash: true,
    });
    expect(
      countOccurrences(prompt, "Finish bias (xAI / Grok worker):"),
    ).toBe(1);
    for (const line of CEREMONY_LINES) {
      expect(countOccurrences(prompt, line)).toBe(1);
    }
  });
});
