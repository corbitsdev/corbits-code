import { expect, test } from "bun:test";

import { createCodingDirector, submitPlanDefinition, submitOutputDefinition } from "./agent/director.js";
import {
  buildActiveContext,
  buildAgentRole,
  buildAvailableTools,
  buildBudgetRules,
  buildChatSystemPrompt,
  buildEnvironmentContext,
  buildFewShot,
  buildGroundingRules,
  buildPlanDecisionRules,
  buildPlanRules,
  buildSelfVerification,
  buildStyleRules,
  buildSubmitRules,
  buildSystemPrompt,
  buildToolCallDiscipline,
} from "./agent/prompts.js";

const minimalToolDefinitions = [submitPlanDefinition, submitOutputDefinition];

test("buildSystemPrompt wires into createCodingDirector without error", () => {
  const prompt = buildSystemPrompt();
  expect(() => createCodingDirector(prompt, minimalToolDefinitions)).not.toThrow();
});

test("buildChatSystemPrompt wires into createCodingDirector without error", () => {
  const prompt = buildChatSystemPrompt();
  expect(() => createCodingDirector(prompt, minimalToolDefinitions)).not.toThrow();
});

test("buildSystemPrompt orders sections: identity, then planning, then work, then finishing", () => {
  const prompt = buildSystemPrompt();
  const role = buildAgentRole();
  const discipline = buildToolCallDiscipline();
  const planDecision = buildPlanDecisionRules();
  const budget = buildBudgetRules();
  const grounding = buildGroundingRules();
  const submit = buildSubmitRules();
  const tools = buildAvailableTools();
  const activeContext = "Active context:";

  // Planning is a turn-1 action, so it precedes the working/finishing rules.
  expect(prompt.indexOf(role)).toBeLessThan(prompt.indexOf(discipline));
  expect(prompt.indexOf(discipline)).toBeLessThan(prompt.indexOf(planDecision));
  expect(prompt.indexOf(planDecision)).toBeLessThan(prompt.indexOf(budget));
  expect(prompt.indexOf(budget)).toBeLessThan(prompt.indexOf(grounding));
  expect(prompt.indexOf(grounding)).toBeLessThan(prompt.indexOf(submit));
  expect(prompt.indexOf(submit)).toBeLessThan(prompt.indexOf(tools));
  expect(prompt.indexOf(tools)).toBeLessThan(prompt.indexOf(activeContext));
});

test("buildSystemPrompt separates sections with double newlines", () => {
  const prompt = buildSystemPrompt();
  // Sections are joined with \n\n — verify at least one boundary exists
  expect(prompt).toContain(buildAgentRole() + "\n\n" + buildToolCallDiscipline());
  expect(prompt).toContain(buildToolCallDiscipline() + "\n\n" + buildPlanDecisionRules());
});

test("buildSystemPrompt includes submit_plan and submit_output in tool list", () => {
  const prompt = buildSystemPrompt();
  expect(prompt).toContain("submit_plan");
  expect(prompt).toContain("submit_output");
});

test("buildSystemPrompt includes web_search and web_fetch in tool list", () => {
  const prompt = buildSystemPrompt();
  expect(prompt).toContain("web_search");
  expect(prompt).toContain("web_fetch");
});

test("buildActiveContext includes the current date in DD/MM/YYYY and the memory path", () => {
  const context = buildActiveContext(new Date(2026, 5, 5), "/repo/root");
  expect(context).toContain("Active context:");
  expect(context).toContain("Current Date: 05/06/2026 (prompt cache survives for <=24hr)");
  expect(context).toContain("/repo/root/.intercode/MEMORY.md");
});

test("active context names the working directory so the agent need not discover it", () => {
  const context = buildActiveContext(new Date(2026, 5, 5), "/repo/root");
  expect(context).toContain("Working Directory: /repo/root");
});

test("system prompt tells the agent not to run pwd or ls to orient", () => {
  const prompt = buildSystemPrompt();
  expect(prompt).toContain("Never run pwd, ls, or find to orient");
});

test("without an env, system and chat prompts end with the static active context", () => {
  const systemPrompt = buildSystemPrompt();
  const chatPrompt = buildChatSystemPrompt();
  expect(systemPrompt.trim()).toMatch(/\.intercode\/MEMORY\.md \(scratch pad for agent\)$/);
  expect(chatPrompt.trim()).toMatch(/\.intercode\/MEMORY\.md \(scratch pad for agent\)$/);
  expect(systemPrompt).toMatch(/Current Date: \d{2}\/\d{2}\/\d{4} \(prompt cache survives for <=24hr\)/);
  expect(chatPrompt).toMatch(/Current Date: \d{2}\/\d{2}\/\d{4} \(prompt cache survives for <=24hr\)/);
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
  const prompt = buildSystemPrompt(undefined, undefined, env);
  expect(prompt).toContain("<env>");
  expect(prompt.trim()).toMatch(/<\/env>$/);
  expect(prompt).toContain("Working directory: /repo/root");
  expect(prompt).toContain("Platform: Darwin 25.4.0");
  expect(prompt).toContain("Git: on main, 2 uncommitted change(s):");
  expect(prompt).toContain(" M src/a.ts");
  expect(prompt).toContain("Top level: src/  tests/  package.json");
  // The static fallback context must not also be present.
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

test("tool discipline prefers web tools over shell for web access", () => {
  const discipline = buildToolCallDiscipline();
  expect(discipline).toContain("use web_search and web_fetch");
  expect(discipline).toContain("Do not use run_shell commands like curl or wget for HTTP(S)");
});

test("system prompt requires web grounding for current or unclear external facts", () => {
  const prompt = buildSystemPrompt();
  expect(prompt).toContain(buildGroundingRules());
  expect(prompt).toContain("facts that may have changed");
  expect(prompt).toContain("use web_search or web_fetch before trying shell-based package or documentation lookups");
});

test("buildSystemPrompt with custom tools lists only those tools", () => {
  const custom = ["read_file", "write_file"];
  const prompt = buildSystemPrompt(custom);
  // The Available tools line should list exactly the custom tools
  expect(prompt).toContain(buildAvailableTools(custom));
  expect(prompt).not.toContain(buildAvailableTools());
});

test("buildChatSystemPrompt excludes agent-mode sections", () => {
  const prompt = buildChatSystemPrompt();
  expect(prompt).not.toContain(buildAgentRole());
  expect(prompt).not.toContain(buildSubmitRules());
  expect(prompt).not.toContain("submit_plan");
  expect(prompt).not.toContain("submit_output");
});

test("buildChatSystemPrompt includes web tools and web access discipline", () => {
  const prompt = buildChatSystemPrompt();
  expect(prompt).toContain("web_search");
  expect(prompt).toContain("web_fetch");
  expect(prompt).toContain("Do not use run_shell commands like curl or wget for HTTP(S)");
  expect(prompt).toContain(buildGroundingRules());
});

test("buildChatSystemPrompt advertises core tools and teaches tool_search for the rest", () => {
  const prompt = buildChatSystemPrompt();
  expect(prompt).toContain("tool_search");
  expect(prompt).toContain("Discoverable tools");
  expect(prompt).toContain("call them on the next turn");
  expect(prompt).toContain("read_file");
  // Discoverable built-ins are named (one-liners), but specific MCP integrations
  // are never enumerated in the prompt — they are discovered blind.
  expect(prompt).not.toContain("mcp__");
});

test("agent identity is Intercode with a quality bar, not an assistant", () => {
  const role = buildAgentRole();
  expect(role).toContain("Intercode");
  expect(role).toContain("senior engineer");
  expect(role.toLowerCase()).not.toContain("assistant");
});

test("system prompt encodes style, self-verification, and a few-shot sequence", () => {
  const prompt = buildSystemPrompt();
  expect(prompt).toContain(buildStyleRules());
  expect(prompt).toContain(buildSelfVerification());
  expect(prompt).toContain(buildFewShot());
  // Core style rules actually present, not just the header.
  expect(prompt).toContain("Stay in scope");
  expect(prompt).toContain("delete the old path");
});

test("planning always submits a plan, scaled by risk not file count", () => {
  const decision = buildPlanDecisionRules();
  // A plan is always required (the runtime gates submit_output on it); the
  // rubric scales plan depth by risk rather than choosing whether to plan.
  expect(decision.toLowerCase()).toContain("submit a plan before you start");
  expect(decision.toLowerCase()).toContain("blast radius");
  // The old rigid thresholds must be gone.
  expect(decision).not.toContain("3 or fewer");
  expect(decision).not.toContain("4 or more");
});

test("chat prompt is Intercode and holds the same code standards", () => {
  const prompt = buildChatSystemPrompt();
  expect(prompt).toContain("Intercode");
  expect(prompt.toLowerCase()).not.toContain("you are a helpful coding assistant");
  expect(prompt).toContain(buildStyleRules());
  expect(prompt).toContain(buildGroundingRules());
});
