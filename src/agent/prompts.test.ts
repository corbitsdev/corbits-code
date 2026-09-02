import { describe, expect, it } from "bun:test";
import {
  buildChatSystemPrompt,
  buildGrokLeafAntiThrashNote,
  buildPromptDisciplineBlock,
  buildSubAgentSystemPrompt,
} from "./prompts.js";
import { CORE_TOOL_NAMES, CATALOG_TOOL_NAMES } from "./tool-search.js";

// Tool names referenced in the discipline block must exist in the actual
// registration source, not be assumed. web_fetch/web_search are catalog tools
// (always advertised) and also registered via createWebFetchTool/createWebSearchTool.
const REGISTERED_TOOL_NAMES = new Set([...CORE_TOOL_NAMES, ...CATALOG_TOOL_NAMES]);

const REFERENCED_TOOL_NAMES = [
  "read_file",
  "edit_file",
  "write_file",
  "run_shell",
  "web_fetch",
  "web_search",
];

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function expectVerificationGuidance(prompt: string): void {
  expect(prompt).toMatch(
    /defined typecheck command.*relevant tests.*defined full verification command/is,
  );
  expect(prompt).toMatch(/repository defines no typecheck command.*explicit Blocker/is);
  expect(prompt).toMatch(/evidence.*AGENTS.*package scripts/is);
  expect(prompt).toMatch(/do not invent.*typecheck command/i);
  expect(prompt).toMatch(/exact verification command.*outcome.*exit status/is);
  expect(prompt).toMatch(/bare .*pass.*incomplete report/is);
  expect(prompt).toMatch(/never silently skip/i);
  expect(prompt).not.toMatch(/relevant checks .*when practical/i);
}

describe("buildPromptDisciplineBlock", () => {
  it("references only tool names that exist in the registration source", () => {
    for (const name of REFERENCED_TOOL_NAMES) {
      expect(REGISTERED_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  it("is tight: roughly 15-25 lines", () => {
    const lines = buildPromptDisciplineBlock().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(15);
    expect(lines.length).toBeLessThanOrEqual(30);
  });

  it("uses prohibition form, not preference form", () => {
    const block = buildPromptDisciplineBlock();
    expect(block).not.toMatch(/\bprefer\b/i);
  });

  it("contains the load-bearing prohibitions", () => {
    const block = buildPromptDisciplineBlock();
    // Dedicated tools over shell.
    expect(block).toContain("run_shell");
    expect(block).toContain("cat/head/tail");
    expect(block).toContain("heredoc/echo");
    // Environment.
    expect(block).toMatch(/never set, export, or prefix environment variables/i);
    expect(block).toMatch(/project settings/i);
    // Web.
    expect(block).toMatch(/curl or wget/i);
    expect(block).toContain("web_fetch");
    expect(block).toContain("web_search");
    // Command shape.
    expect(block).toMatch(/one logical operation per call/i);
    // Turn semantics.
    expect(block).toMatch(
      /no tool calls.*final answer|reply with no tool calls is the final answer/i,
    );
    expect(block).toMatch(/three failures/i);
    expect(block).toMatch(/repeat a search/i);
    expect(block).toMatch(/parallel/i);
    // TTY output.
    expect(block).toMatch(/wide table/i);
    expect(block).toMatch(/backticks/i);
  });
});

describe("shared discipline block appears exactly once per built prompt", () => {
  it("appears exactly once in the orchestrator chat prompt", () => {
    const prompt = buildChatSystemPrompt(undefined, undefined, undefined, [], "orchestrator");
    expect(countOccurrences(prompt, "Prompt discipline:")).toBe(1);
  });

  it("appears exactly once in a worker prompt (default family)", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: false,
      grokAntiThrash: false,
    });
    expect(countOccurrences(prompt, "Prompt discipline:")).toBe(1);
  });

  it("appears exactly once in a grok worker prompt", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: false,
      grokAntiThrash: true,
    });
    expect(countOccurrences(prompt, "Prompt discipline:")).toBe(1);
  });

  it("appears exactly once in an orchestrator sub-agent prompt", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: true,
      grokAntiThrash: false,
    });
    expect(countOccurrences(prompt, "Prompt discipline:")).toBe(1);
  });
});

describe("shared verification guidance", () => {
  it("requires evidence-carrying verification in worker prompts", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: false,
      grokAntiThrash: false,
    });
    expectVerificationGuidance(prompt);
  });

  it("requires evidence-carrying verification in orchestrator chat prompts", () => {
    const prompt = buildChatSystemPrompt(undefined, undefined, undefined, [], "orchestrator");
    expectVerificationGuidance(prompt);
  });
});

describe("grok finish-bias residual gating (extends existing provider-family tests)", () => {
  it("is present for a grok worker", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: false,
      grokAntiThrash: true,
    });
    expect(prompt).toContain("Finish bias (xAI / Grok worker):");
  });

  it("is absent for a non-grok worker", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: false,
      grokAntiThrash: false,
    });
    expect(prompt).not.toContain("Finish bias (xAI / Grok worker):");
  });

  it("is never applied to orchestrators, mirroring shouldApplyGrokAntiThrash", () => {
    // Callers gate grokAntiThrash off for orchestrators upstream (see
    // src/subagent/index.ts and shouldApplyGrokAntiThrash); confirm the prompt
    // builder itself does not silently re-add it when orchestrator is true.
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: true,
      grokAntiThrash: false,
    });
    expect(prompt).not.toContain("Finish bias (xAI / Grok worker):");
  });

  it("reinforces tool routing (dedicated tools over shell) for grok, not just finish bias", () => {
    const note = buildGrokLeafAntiThrashNote();
    expect(note).toMatch(/run_shell/);
  });

  it("has no kimi residual — the seam is intentionally left unfilled", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: false,
      grokAntiThrash: false,
    });
    expect(prompt.toLowerCase()).not.toContain("kimi");
  });
});
