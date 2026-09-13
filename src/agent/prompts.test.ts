import { describe, expect, it } from "bun:test";
import {
  buildChatSystemPrompt,
  buildGrokLeafAntiThrashNote,
  buildGuidelines,
  buildPromptDisciplineBlock,
  buildSubAgentSystemPrompt,
  GUIDELINE_SUB_BLOCK_IDS,
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
  expect(prompt).toMatch(
    /repository defines no typecheck command.*explicit Blocker/is,
  );
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

describe("shared discipline block appears exactly once per built prompt", () => {
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
  it("exposes the keepstyle set as ids", () => {
    expect([...GUIDELINE_SUB_BLOCK_IDS]).toEqual([
      "responseStyle",
      "toolChoice",
      "askVsProceed",
      "scopeConventions",
      "orchestration",
    ]);
  });

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

  it("goldens the default guidelines byte-for-byte (separator shifts fail loudly)", () => {
    expect(buildGuidelines({})).toBe(`Guidelines:

Response style:
- Default to short, direct answers; skip preamble and filler.
- For substantial work, lead with the outcome, then what changed and why; use bullets or short headers only when they help scanning.
- Cite paths instead of pasting large files; fenced snippets only when essential.
- No emojis in code or docs unless the user uses them.

Tool choice:
- Prefer spawn_agent(agent=…) then idle for substantial product implementation, exploration, review, and docs — mailbox mail arrives as inbound; do not poll. Spawn remains default for substantial work, not a tool ban.
- read_file for file contents; grep or search_files to locate code; lsp for symbols, types, references, or call flow before opening large files.
- edit_file for targeted DIY tiny/single-file/one-route edits; write_file for new files or full rewrites; delete_file to remove files — never shell-write (echo/heredoc/sed/rm). Spawn builder (or a docs director) for substantial/multi-file/parallel/specialist work.
- run_shell for builds, tests, git, and one-off commands — not for shell find, head-position rg, or recursive grep -r (OOM risk), cat, or messaging the user.
- tool_search before assuming a plugin or MCP tool exists; skill_search when choosing among listed skills, use_skill to load a body.

Ask vs proceed:
- Clear, bounded coding requests: proceed autonomously; use ask_operator only when permission blocks you or the request is genuinely ambiguous (missing repro, conflicting instructions, destructive choice).
- Before ask_operator: put long rationale in a normal transcript reply first, then call ask_operator with a short question and short option labels only.
- Questions, reviews, and product/visual feedback: answer or diagnose first; do not edit until the user wants a change.
- Preserve unrelated user edits; never revert changes you did not make unless asked.
- Unexpected changes in files you did not touch: stop and ask_operator.

Scope and conventions:
- Touch only code required for the task; no drive-by refactors, formatting sweeps, or unrelated fixes.
- Follow AGENTS.md and /docs for architecture; use_skill style and philosophy when starting repo work.
- Match existing project patterns (functional style, arktype at boundaries, small focused diffs).
- Before finishing implementation work, run the repository-defined typecheck command, relevant tests, and every defined full verification command; these checks are mandatory.
- If the repository defines no typecheck command, do not invent a typecheck command: report its absence as an explicit Blocker with evidence from AGENTS.md and package scripts (or equivalent project configuration).
- In Findings, report every exact verification command and its outcome, including exit status. A bare \`pass\` without command evidence is an incomplete report.
- If a required check genuinely cannot run because of a missing runtime or dependency, sandbox restriction, or permissions, record the exact inability under Blockers; never silently skip a required check.

Orchestration:
- Break multi-step or parallel work into focused worker dispatches with distinct lenses; prefer \`spawn_agent\` (fire several in one turn when jobs are independent), then reply with who is running and end the turn — workers keep running while you are idle. Mailbox mail arrives as inbound when a worker finishes; read it and do not poll. \`list_agents\` shows the fleet without blocking; after a parked ask is surfaced, answer with \`send_input\` and do not poll \`list_agents\`.
- Pass the typed spawn contract: \`intent\`, \`success_criteria\` (done-when; required for implement/review and their default directors), \`do_not\` (scope fence), and \`report_focus\`. Free-form \`prompt\` without \`success_criteria\` fail-closes for implement/review and their default directors.
- After workers return, classify fail / incomplete-report vs parent-initiated interrupt vs operator-cancel vs clean complete. Fail-path (\`status: failed\` or salvage \`incomplete-report\`): diagnose from the report or error and MAY spawn one successor with a changed brief. Parent-initiated interrupt (\`interrupt_agent\` / \`send_input\` with \`interrupt:true\` unblocks wait with \`stop_reason: interrupted\`): the worker is often still running and often has no report — \`resume_agent\`, or idle for its mailbox mail; do not \`spawn_agent\` a successor against a still-live worker. Successor only if that session is no longer resumable. Operator-cancel (\`stop_reason\` cancelled): wait for the operator; do not auto-retry. Identical brief: refuse. Merge Summary/Findings into a coherent answer for the operator; do not paste raw fleet-agent dumps.
- Use manage_tasks for your own coordination checklist; spawning workers is \`spawn_agent\`, not manage_tasks.
- If context is compacted automatically, do not stop tasks early due to token fear; persist progress via manage_tasks and worker reports.`);
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
    // No wait_agents tool ad on an unmounted primary — only the exec-only note.
    expect(prompt).not.toContain("- wait_agents:");
    expect(prompt).not.toContain("collect with wait_agents");
    expect(prompt).toContain(
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
  it("requires evidence-carrying verification in worker prompts", () => {
    const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
      orchestrator: false,
      grokAntiThrash: false,
    });
    expectVerificationGuidance(prompt);
  });

  it("requires evidence-carrying verification in orchestrator chat prompts", () => {
    const prompt = buildChatSystemPrompt(
      undefined,
      undefined,
      undefined,
      [],
      "orchestrator",
    );
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
