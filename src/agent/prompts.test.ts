import { describe, expect, it } from "bun:test";
import {
  buildChatSystemPrompt,
  buildClaudeTaskGuidanceNote,
  buildGptNarrateBeforeToolsNote,
  buildGrokLeafAntiThrashNote,
  buildGuidelines,
  buildPromptDisciplineBlock,
  buildSubAgentSystemPrompt,
} from "./prompts.js";
import { CORE_TOOL_NAMES, CATALOG_TOOL_NAMES } from "./tool-search.js";

// Tool names referenced in the discipline block must exist in the actual
// registration source, not be assumed. web_fetch/web_search are catalog tools
// (always advertised) and also registered via createWebFetchTool/createWebSearchTool.
const REGISTERED_TOOL_NAMES = new Set([
  ...CORE_TOOL_NAMES,
  ...CATALOG_TOOL_NAMES,
]);

const REFERENCED_TOOL_NAMES = [
  "read",
  "edit",
  "write",
  "bash",
  "web_fetch",
  "web_search",
];

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// Module-scope snapshot of the repeated no-arg discipline builder. The block
// is static text for absent input, so the no-arg calls below share one value.
const PROMPT_DISCIPLINE_BLOCK = buildPromptDisciplineBlock();

describe("buildPromptDisciplineBlock", () => {
  it("references only tool names that exist in the registration source", () => {
    for (const name of REFERENCED_TOOL_NAMES) {
      expect(REGISTERED_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  it("is tight: roughly 15-25 lines", () => {
    const lines = PROMPT_DISCIPLINE_BLOCK.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(15);
    expect(lines.length).toBeLessThanOrEqual(30);
  });

  it("contains the load-bearing prohibitions", () => {
    const block = PROMPT_DISCIPLINE_BLOCK;
    // Dedicated tools over shell.
    expect(block).toContain("bash");
    expect(block).toContain("cat/head/tail");
    expect(block).toContain("heredoc/echo");
    // Environment.
    expect(block).toMatch(
      /never set, export, or prefix environment variables/i,
    );
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

describe("shared discipline block appears exactly once per primary prompt, never in worker prompts", () => {
  it("appears exactly once in the orchestrator chat prompt", () => {
    const prompt = buildChatSystemPrompt(
      undefined,
      undefined,
      undefined,
      [],
      "orchestrator",
    );
    expect(countOccurrences(prompt, "Prompt discipline:")).toBe(1);
  });

  // Lean workers (CL-8212) carry the contract instead of the shared blocks.
  it("is absent from a worker prompt (default family)", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: false,
      grokAntiThrash: false,
    });
    expect(countOccurrences(prompt, "Prompt discipline:")).toBe(0);
  });

  it("is absent from a grok worker prompt", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: false,
      grokAntiThrash: true,
    });
    expect(countOccurrences(prompt, "Prompt discipline:")).toBe(0);
  });

  it("is absent from an orchestrator sub-agent prompt", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: true,
      grokAntiThrash: false,
    });
    expect(countOccurrences(prompt, "Prompt discipline:")).toBe(0);
  });
});

describe("sub-agent report contract", () => {
  it("requires all four headings with None. instead of omitting empty sections", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: false,
      grokAntiThrash: false,
    });
    expect(prompt).not.toContain("omit empty sections");
    expect(prompt).toMatch(/emit all four headings/);
    expect(prompt).toContain('"None."');
  });

  it("emits the four-heading envelope exactly once (scaffold owns the shape)", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: false,
      grokAntiThrash: false,
    });
    for (const heading of [
      "## Summary",
      "## Findings",
      "## Blockers",
      "## Paths",
    ]) {
      expect(countOccurrences(prompt, heading)).toBe(1);
    }
  });
});

describe("guideline sub-block omit policy (CL-7654)", () => {
  it("keeps the full guidelines by default", () => {
    const guidelines = buildGuidelines({});
    for (const marker of [
      "Response style:",
      "Tool choice:",
      "Ask vs proceed:",
      "Scope and conventions:",
      "Orchestration:",
    ]) {
      expect(guidelines).toContain(marker);
    }
  });

  it("omit keeps response style, drops tool-choice / ask-vs-proceed / orchestration", () => {
    const guidelines = buildGuidelines({
      omit: ["toolChoice", "askVsProceed", "orchestration"],
    });
    expect(guidelines).toContain("Response style:");
    expect(guidelines).toContain("Scope and conventions:");
    expect(guidelines).not.toContain("Tool choice:");
    expect(guidelines).not.toContain("Ask vs proceed:");
    expect(guidelines).not.toContain("Orchestration:");
  });

  it("threads guidelineConfig through the chat system prompt", () => {
    const full = buildChatSystemPrompt(
      undefined,
      undefined,
      undefined,
      [],
      "orchestrator",
    );
    expect(full).toContain("Tool choice:");
    expect(full).toContain("Orchestration:");
    const keepstyle = buildChatSystemPrompt(
      undefined,
      undefined,
      undefined,
      [],
      "orchestrator",
      undefined,
      { omit: ["toolChoice", "askVsProceed", "orchestration"] },
    );
    expect(keepstyle).toContain("Response style:");
    expect(keepstyle).not.toContain("Tool choice:");
    expect(keepstyle).not.toContain("Orchestration:");
  });
});

describe("wait_agents mount-gated prompt copy (CL-7678)", () => {
  const TUI_AVAILABILITY = {
    languageServerAvailable: false,
    operatorAvailable: false,
  };
  function chatPrompt(
    toolAvailability:
      | typeof TUI_AVAILABILITY
      | (typeof TUI_AVAILABILITY & { waitAgentsMounted: boolean }),
  ): string {
    return buildChatSystemPrompt(
      undefined,
      undefined,
      undefined,
      [],
      "orchestrator",
      toolAvailability,
    );
  }

  it("tells an unmounted primary to spawn then idle on mailbox mail", () => {
    const prompt = chatPrompt(TUI_AVAILABILITY);
    expect(prompt).toContain("mailbox mail arrives as inbound");
    // No wait_agents tool ad on an unmounted primary — and no mount-fact
    // restatement either (CL-6953: the mount lives in the runtime toolset +
    // mount-gated guidelines copy, not the static prompt; naming an unmounted
    // tool is an impossible-tool ref per CL-6807 hygiene).
    expect(prompt).not.toContain("- wait_agents:");
    expect(prompt).not.toContain("collect with wait_agents");
    expect(prompt).not.toContain(
      "wait_agents is mounted on exec-primary runs only",
    );
  });

  it("keeps the wait_agents collect path on an exec-mounted primary", () => {
    const prompt = chatPrompt({ ...TUI_AVAILABILITY, waitAgentsMounted: true });
    expect(prompt).toContain("- wait_agents:");
    expect(prompt).toContain("collect with wait_agents");
  });
});

describe("shared verification guidance", () => {
  it("lean worker prompts carry the report envelope, not the full verification guidance", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: false,
      grokAntiThrash: false,
    });
    // The envelope still demands evidence in Findings; the multi-line
    // typecheck/test/full-gate guidance stays on the primary prompt.
    expect(prompt).toContain("## Findings");
    expect(prompt).not.toMatch(
      /defined typecheck command.*relevant tests.*defined full verification command/is,
    );
  });

  it("requires evidence-carrying verification in orchestrator chat prompts", () => {
    const prompt = buildChatSystemPrompt(
      undefined,
      undefined,
      undefined,
      [],
      "orchestrator",
    );
    expect(prompt).toMatch(
      /defined typecheck command.*relevant tests.*defined full verification command/is,
    );
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
    expect(note).toMatch(/bash/);
  });

  it("has no kimi residual — the seam is intentionally left unfilled", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: false,
      grokAntiThrash: false,
    });
    expect(prompt.toLowerCase()).not.toContain("kimi");
  });
});

describe("promptResidual assembly (CL-8297)", () => {
  const TOOL_BUDGET =
    "Tool budget:\n" +
    "- Batch independent tool calls into a single turn.\n" +
    "- Never re-issue a tool call whose result you already have.\n" +
    "- When the next call would only repeat prior work, write the report instead.";

  it("appends promptResidual exactly once at the tail for a grok leaf", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: false,
      grokAntiThrash: true,
      promptResidual: TOOL_BUDGET,
    });
    expect(countOccurrences(prompt, TOOL_BUDGET)).toBe(1);
    expect(prompt.trimEnd().endsWith(TOOL_BUDGET)).toBe(true);
  });

  it("omits the tool budget when promptResidual is unset", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: false,
      grokAntiThrash: true,
    });
    expect(prompt).not.toContain("Tool budget:");
  });
});

describe("claude XML task_guidance residual (provider residual, not a prompt fork)", () => {
  it("appends exactly one balanced <task_guidance> block for a claude worker", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: false,
      promptResidual: buildClaudeTaskGuidanceNote(),
    });
    expect(countOccurrences(prompt, "<task_guidance>")).toBe(1);
    expect(countOccurrences(prompt, "</task_guidance>")).toBe(1);
  });

  it("is absent without promptResidual — grok, gpt, and orchestrator rows untouched", () => {
    for (const opts of [
      { orchestrator: false },
      { orchestrator: false, grokAntiThrash: true },
      { orchestrator: true },
    ] as const) {
      const prompt = buildSubAgentSystemPrompt(
        undefined,
        undefined,
        undefined,
        opts,
      );
      expect(prompt).not.toContain("<task_guidance>");
      expect(prompt).not.toContain("</task_guidance>");
    }
  });

  it("emits one block with balanced tags, never a full-prompt XML renderer", () => {
    const note = buildClaudeTaskGuidanceNote();
    expect(countOccurrences(note, "<task_guidance>")).toBe(1);
    expect(countOccurrences(note, "</task_guidance>")).toBe(1);
    expect(note).not.toMatch(/<system_prompt>|<prompt>|<identity>/);
  });

  it("keeps the measured CL-7775 shape: rationale first, numbered approach, named output contract, positively framed", () => {
    const lines = buildClaudeTaskGuidanceNote().split("\n");
    // Rationale first: the lead line frames the turn before any directive.
    expect(lines[1]).toMatch(/^Autonomous coding turn:/);
    // Numbered approach, not bullets.
    expect(lines.slice(2, 5).map((l) => l.split(".")[0])).toEqual([
      "1",
      "2",
      "3",
    ]);
    // Named output contract.
    expect(buildClaudeTaskGuidanceNote()).toContain(
      "structured report envelope",
    );
    // Positive framing: no negative imperatives.
    expect(buildClaudeTaskGuidanceNote()).not.toMatch(
      /\b(do not|don't|never|stop calling)\b/i,
    );
  });
});

describe("gpt narrate-before-tools residual (CL-8310)", () => {
  it("is a 3-line narrate-before-tools note, not manage_tasks ceremony", () => {
    const note = buildGptNarrateBeforeToolsNote();
    expect(note).toContain("Narrate before tools (GPT worker):");
    expect(note).toMatch(/before.*tool call.*one short line/is);
    expect(note).toMatch(/no narration between them/i);
    expect(note).toContain("write the report envelope");
    expect(note.toLowerCase()).not.toContain("manage_tasks");
  });

  it("appears exactly once on a gpt leaf prompt", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: false,
      promptResidual: buildGptNarrateBeforeToolsNote(),
    });
    const note = buildGptNarrateBeforeToolsNote();
    expect(countOccurrences(prompt, note)).toBe(1);
    expect(prompt.trimEnd().endsWith(note)).toBe(true);
  });

  it("appears exactly once on a gpt primary prompt", () => {
    const prompt = buildChatSystemPrompt(
      undefined,
      undefined,
      undefined,
      [],
      "orchestrator",
      undefined,
      undefined,
      { promptResidual: buildGptNarrateBeforeToolsNote() },
    );
    const note = buildGptNarrateBeforeToolsNote();
    expect(countOccurrences(prompt, note)).toBe(1);
  });

  it("is absent by default on both primary and leaf", () => {
    const leaf = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: false,
      grokAntiThrash: false,
    });
    const primary = buildChatSystemPrompt(
      undefined,
      undefined,
      undefined,
      [],
      "orchestrator",
    );
    expect(leaf).not.toContain("Narrate before tools (GPT worker):");
    expect(primary).not.toContain("Narrate before tools (GPT worker):");
  });

  it("is absent on grok and claude prompts", () => {
    const grokLeaf = buildSubAgentSystemPrompt(
      undefined,
      undefined,
      undefined,
      {
        orchestrator: false,
        grokAntiThrash: true,
      },
    );
    const claudeLeaf = buildSubAgentSystemPrompt(
      undefined,
      undefined,
      undefined,
      {
        orchestrator: false,
        grokAntiThrash: false,
      },
    );
    const claudePrimary = buildChatSystemPrompt(
      undefined,
      undefined,
      undefined,
      [],
      "orchestrator",
    );
    for (const prompt of [grokLeaf, claudeLeaf, claudePrimary]) {
      expect(prompt).not.toContain("Narrate before tools (GPT worker):");
      expect(prompt).not.toContain("Narrate before tools (GPT");
    }
    // The grok row keeps its own residual, untouched.
    expect(grokLeaf).toContain("Finish bias (xAI / Grok worker):");
  });
});
