import { expect, test } from "bun:test";

import { createChatDirector, submitOutputDefinition } from "./agent/director.js";
import { manageTasksDefinition } from "./agent/tasks.js";
import { CHAT_PROMPT_QUALITY_MARKERS } from "./agent/prompt-contract.js";
import {
  buildActiveContext,
  buildAvailableTools,
  buildChatRole,
  buildChatSystemPrompt,
  buildEnvironmentContext,
  buildGuidelines,
  buildHarnessFacts,
  buildSubAgentReportContract,
  buildSubAgentSystemPrompt,
} from "./agent/prompts.js";

const minimalToolDefinitions = [manageTasksDefinition, submitOutputDefinition];

test("buildChatSystemPrompt wires into createChatDirector without error", () => {
  const prompt = buildChatSystemPrompt();
  expect(() => createChatDirector(prompt, minimalToolDefinitions)).not.toThrow();
});

test("chat prompt orders base, then tools, then context", () => {
  const prompt = buildChatSystemPrompt();
  expect(prompt.indexOf(buildChatRole())).toBe(0);
  expect(prompt.indexOf(buildChatRole())).toBeLessThan(prompt.indexOf(buildHarnessFacts()));
  expect(prompt.indexOf(buildHarnessFacts())).toBeLessThan(prompt.indexOf(buildGuidelines()));
  expect(prompt.indexOf(buildGuidelines())).toBeLessThan(prompt.indexOf("Tools:"));
  expect(prompt.indexOf("Tools:")).toBeLessThan(prompt.indexOf("Active context:"));
});

test("agent identity is Corbits Code with mode-specific primary roles", () => {
  const single = buildChatRole("single");
  expect(single).toContain("Corbits Code");
  expect(single).toContain("senior coding assistant");
  expect(single).toContain("read, edit");
  const orchestrator = buildChatRole("orchestrator");
  expect(orchestrator).toContain("Corbits Code");
  expect(orchestrator).toContain("orchestrator");
  expect(orchestrator).toContain("delegate");
  expect(orchestrator).toContain("Match their tone");
});

test("harness facts state only the non-derivable tool and safety rules", () => {
  const facts = buildHarnessFacts();
  expect(facts).toContain("write_file/edit_file");
  expect(facts).toContain("blocked");
  expect(facts).toContain("15s timeout");
  expect(facts).toContain("find, rg, and grep -r");
  expect(facts).toContain("operator approval");
  expect(facts).toContain("tool_search");
  expect(facts).toContain("plugins or integrations");
  expect(facts).toContain("slash-command steps");
  expect(facts).toContain(".corbits/MEMORY.md");
  expect(facts).toContain("Attached images are native multimodal input");
  expect(facts).not.toContain("Tool results already render richly");
});

test("guidelines cover response style, tool choice, ask vs proceed, and scope", () => {
  const guidelines = buildGuidelines();
  expect(guidelines).toContain("Response style:");
  expect(guidelines).toContain("Tool choice:");
  expect(guidelines).toContain("Ask vs proceed:");
  expect(guidelines).toContain("Scope and conventions:");
  expect(guidelines).toContain("grep or search_files");
  expect(guidelines).toContain("ask_operator only when permission blocks you");
  expect(guidelines).toContain("load the style and philosophy skills");
});

test("chat system prompt satisfies system prompt quality markers", () => {
  const prompt = buildChatSystemPrompt();
  for (const marker of CHAT_PROMPT_QUALITY_MARKERS) {
    expect(prompt).toContain(marker);
  }
});

test("single session mode satisfies system prompt quality markers", () => {
  const prompt = buildChatSystemPrompt(undefined, undefined, undefined, [], "single");
  for (const marker of CHAT_PROMPT_QUALITY_MARKERS) {
    expect(prompt).toContain(marker);
  }
});

test("single session mode omits task and search_agents from the tools list", () => {
  const prompt = buildChatSystemPrompt(undefined, undefined, undefined, [], "single");
  expect(prompt).toContain("read_file");
  expect(prompt).not.toContain("- task:");
  expect(prompt).not.toContain("- search_agents:");
});

test("orchestrator session mode lists task and search_agents", () => {
  const prompt = buildChatSystemPrompt(undefined, undefined, undefined, [], "orchestrator");
  expect(prompt).toContain("- task:");
  expect(prompt).toContain("- search_agents:");
});

test("chat prompt advertises core tools but never enumerates MCP integrations", () => {
  const prompt = buildChatSystemPrompt();
  expect(prompt).toContain("read_file");
  expect(prompt).toContain("tool_search");
  expect(prompt).not.toContain("mcp__");
  // No static catalog dump — discovery is via tool_search, not a listed catalog.
  expect(prompt).not.toContain("Discoverable tools");
});

test("lists skills and advertises use_skill when skills exist", () => {
  const prompt = buildChatSystemPrompt(undefined, undefined, undefined, [
    { name: "scribe", description: "write docs" },
  ]);
  expect(prompt).toContain("Skills (");
  expect(prompt).toContain("- scribe: write docs");
  expect(prompt).toContain("use_skill");
});

test("omits the skills section when no skills are available", () => {
  expect(buildChatSystemPrompt()).not.toContain("Skills (");
});

test("a SYSTEM.md base override replaces the static base but keeps tools and context", () => {
  const override = "You are a custom agent with project-specific rules.";
  const prompt = buildChatSystemPrompt(undefined, undefined, override);
  expect(prompt).toContain(override);
  expect(prompt).not.toContain(buildChatRole());
  expect(prompt).toContain("## Session mode");
  expect(prompt).toContain("Orchestration:");
  // Tools and context still attach.
  expect(prompt).toContain("Tools:");
  expect(prompt).toContain("Active context:");
});

test("SYSTEM.md override in single mode still appends single-agent harness rules", () => {
  const override = "You are a custom agent that mentions delegating to workers.";
  const prompt = buildChatSystemPrompt(undefined, undefined, override, [], "single");
  expect(prompt).toContain(override);
  expect(prompt).toContain("single-agent mode");
  expect(prompt).not.toContain("- task:");
});

test("an empty base override falls back to the default base", () => {
  const prompt = buildChatSystemPrompt(undefined, undefined, "   ");
  expect(prompt).toContain(buildChatRole());
  expect(prompt).toContain(buildHarnessFacts());
});

test("extensions are appended after the base, tools, and context", () => {
  const ext = "## Project guidance\n\nUse tabs, not spaces.";
  const prompt = buildChatSystemPrompt([ext]);
  expect(prompt).toContain(ext);
  expect(prompt.indexOf("Active context:")).toBeLessThan(prompt.indexOf(ext));
});

test("buildActiveContext includes the current date in DD/MM/YYYY and the memory path", () => {
  const context = buildActiveContext(new Date(2026, 5, 5), "/repo/root");
  expect(context).toContain("Active context:");
  expect(context).toContain("Current Date: 05/06/2026 (prompt cache survives for <=24hr)");
  expect(context).toContain("/repo/root/.corbits/MEMORY.md");
  expect(context).toContain("Working Directory: /repo/root");
});

test("without an env, the chat prompt ends with the static active context", () => {
  const prompt = buildChatSystemPrompt();
  expect(prompt.trim()).toMatch(/\.corbits\/MEMORY\.md/);
  expect(prompt).toMatch(/Current Date: \d{2}\/\d{2}\/\d{4} \(prompt cache survives for <=24hr\)/);
});

test("when an env is supplied, the prompt ends with a live <env> block instead", () => {
  const env = {
    cwd: "/repo/root",
    platform: "Darwin 25.4.0",
    date: new Date(2026, 5, 5),
    isGitRepo: true,
    gitBranch: "main",
    gitDirtyCount: 2,
    gitStatusSummary: " M src/a.ts\n?? tmp/",
    topLevel: "src/  tests/  package.json",
  };
  const prompt = buildChatSystemPrompt(undefined, env);
  expect(prompt).toContain("<env>");
  expect(prompt.trim()).toMatch(/<\/env>$/);
  expect(prompt).toContain("Working directory: /repo/root");
  expect(prompt).toContain("Git: on main, 2 uncommitted change(s):");
  expect(prompt).toContain(" M src/a.ts");
  expect(prompt).not.toContain("Active context:");
});

test("buildEnvironmentContext reports a clean tree and a non-git directory", () => {
  const clean = buildEnvironmentContext({
    cwd: "/r",
    platform: "Linux 6",
    date: new Date(2026, 0, 1),
    isGitRepo: true,
    gitBranch: "dev",
    gitDirtyCount: 0,
  });
  expect(clean).toContain("Git: on dev, working tree clean");

  const noGit = buildEnvironmentContext({
    cwd: "/r",
    platform: "Linux 6",
    date: new Date(2026, 0, 1),
    isGitRepo: false,
  });
  expect(noGit).toContain("Git: not a git repository");
});

test("buildAvailableTools lists exactly the tools it is given", () => {
  const custom = ["read_file", "write_file"];
  const listed = buildAvailableTools(custom);
  expect(listed).toContain("read_file");
  expect(listed).toContain("write_file");
  expect(listed).not.toContain("tool_search");
});

test("sub-agent prompt carries the report-back contract and harness facts", () => {
  const prompt = buildSubAgentSystemPrompt();
  expect(prompt).toContain("short-lived child agent dispatched by Corbits Code");
  expect(prompt).toContain("Reporting back:");
  expect(prompt).toContain("only thing returned to the parent");
  expect(prompt).toContain("Change files with write_file/edit_file");
  expect(prompt).toContain("remove files with delete_file");
  expect(prompt).toContain("parent session's permission gate");
  expect(prompt).not.toContain("without asking for approval");
  expect(prompt).not.toContain("ask_operator");
});

test("sub-agent report contract treats Success criteria as completion gate", () => {
  const contract = buildSubAgentReportContract();
  expect(contract).toContain("Success criteria");
  expect(contract).toContain("done-definition");
  expect(contract).toContain("stop calling tools");
  expect(contract).toContain("Do not");
  expect(contract).toContain("Intent / Do not");
});

test("sub-agent prompt does not advertise tool_search (it gets the full toolset)", () => {
  const prompt = buildSubAgentSystemPrompt();
  expect(prompt).not.toContain("tool_search");
  expect(prompt).toContain("your full toolset");
});

// Pins the appendix-last invariant for JS-plugin agents: regardless of how the
// systemPromptRole is sourced (data-only markdown vs. a JS plugin's
// `agentPlugin.agents[i].systemPromptRole`), `buildSubAgentSystemPrompt` is
// the single point that appends the Corbits Code translation notes — so a
// JS-plugin-only path that bypasses the data-only loader still gets them.
test("sub-agent prompt always appends Corbits Code notes, even with a JS-plugin-style systemPromptRole", () => {
  const role = "You are a JS-plugin scout. Map the call graph and report.";
  const prompt = buildSubAgentSystemPrompt([role]);
  expect(prompt).toContain(role);
  expect(prompt).toContain("## Corbits Code notes");
  // Leaf agents get the no-recursion rule, not the spawn syntax.
  expect(prompt).toContain("leaf sub-agent");
  // Agent voice leads; translation notes are the last section.
  expect(prompt.indexOf(role)).toBeLessThan(prompt.indexOf("## Corbits Code notes"));
});

// Default sub-agents must NOT recurse — the appendix tells them to return a
// concrete report instead of spawning further agents. This is the rule that
// stops a fan-out of sub-agents each fanning out further.
test("default sub-agent prompt forbids recursion", () => {
  const prompt = buildSubAgentSystemPrompt();
  expect(prompt).toContain("Only the primary Corbits Code session (or an orchestrator profile) may call `task`");
  expect(prompt).toContain("leaf sub-agent");
});

// Orchestrator profiles (frontmatter `orchestrator: true`) are the documented
// exception to the no-recursion rule — their purpose IS to fan work out to
// other agents. The appendix grants them permission and links the syntax.
test("orchestrator sub-agent prompt grants the task-tool recursion exception", () => {
  const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
    orchestrator: true,
  });
  expect(prompt).toContain("You are an orchestrator");
  expect(prompt).toContain("MAY call `task`");
  expect(prompt).toContain('task(agent="');
  // Must NOT contain the default no-recursion line — that would contradict
  // the permission grant in the same appendix.
  expect(prompt).not.toContain("Only the primary Corbits Code session (or an orchestrator profile) may call `task`");
});

test("sub-agent prompt requires structured report envelope and stick-to-brief", () => {
  const prompt = buildSubAgentSystemPrompt();
  expect(prompt).toContain("## Summary");
  expect(prompt).toContain("## Findings");
  expect(prompt).toContain("## Blockers");
  expect(prompt).toContain("## Paths");
  expect(prompt).toContain("Stick to the dispatch brief");
  expect(prompt).toContain("manage_tasks checklist");
});
