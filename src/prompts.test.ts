import { expect, test } from "bun:test";

import { createCodingDirector, submitOutputDefinition } from "./agent/director.js";
import { manageTasksDefinition } from "./agent/tasks.js";
import {
  buildActiveContext,
  buildAvailableTools,
  buildChatRole,
  buildChatSystemPrompt,
  buildEnvironmentContext,
  buildGuidelines,
  buildHarnessFacts,
  buildSubAgentSystemPrompt,
} from "./agent/prompts.js";

const minimalToolDefinitions = [manageTasksDefinition, submitOutputDefinition];

test("buildChatSystemPrompt wires into createCodingDirector without error", () => {
  const prompt = buildChatSystemPrompt();
  expect(() => createCodingDirector(prompt, minimalToolDefinitions)).not.toThrow();
});

test("chat prompt orders base, then tools, then context", () => {
  const prompt = buildChatSystemPrompt();
  expect(prompt.indexOf(buildChatRole())).toBe(0);
  expect(prompt.indexOf(buildChatRole())).toBeLessThan(prompt.indexOf(buildHarnessFacts()));
  expect(prompt.indexOf(buildHarnessFacts())).toBeLessThan(prompt.indexOf(buildGuidelines()));
  expect(prompt.indexOf(buildGuidelines())).toBeLessThan(prompt.indexOf("Tools:"));
  expect(prompt.indexOf("Tools:")).toBeLessThan(prompt.indexOf("Active context:"));
});

test("agent identity is Intercode, a senior engineer, not an assistant", () => {
  const role = buildChatRole();
  expect(role).toContain("Intercode");
  expect(role).toContain("senior engineer");
  expect(role.toLowerCase()).not.toContain("assistant");
});

test("harness facts state the non-derivable rules: blocked shell writes, approval, tool_search", () => {
  const facts = buildHarnessFacts();
  expect(facts).toContain("write_file/edit_file");
  expect(facts).toContain("blocked");
  expect(facts).toContain("need operator approval");
  expect(facts).toContain("tool_search");
  expect(facts).toContain(".agent-state");
  expect(facts).toContain("slash-command only");
  expect(facts).toContain(".intercode/MEMORY.md");
});

test("guidelines prefer lsp before large files and keep responses concise", () => {
  const guidelines = buildGuidelines();
  expect(guidelines).toContain("use lsp before opening large files");
  expect(guidelines).toContain("Be concise");
  expect(guidelines).toContain("stay in scope");
});

test("chat prompt advertises core tools but never enumerates MCP integrations", () => {
  const prompt = buildChatSystemPrompt();
  expect(prompt).toContain("read_file");
  expect(prompt).toContain("tool_search");
  expect(prompt).not.toContain("mcp__");
  // No static catalog dump — discovery is via tool_search, not a listed catalog.
  expect(prompt).not.toContain("Discoverable tools");
});

test("a SYSTEM.md base override replaces the static base but keeps tools and context", () => {
  const override = "You are a custom agent with project-specific rules.";
  const prompt = buildChatSystemPrompt(undefined, undefined, override);
  expect(prompt).toContain(override);
  expect(prompt).not.toContain(buildChatRole());
  expect(prompt).not.toContain(buildHarnessFacts());
  // Tools and context still attach.
  expect(prompt).toContain("Tools:");
  expect(prompt).toContain("Active context:");
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
  expect(context).toContain("/repo/root/.intercode/MEMORY.md");
  expect(context).toContain("Working Directory: /repo/root");
});

test("without an env, the chat prompt ends with the static active context", () => {
  const prompt = buildChatSystemPrompt();
  expect(prompt.trim()).toMatch(/\.intercode\/MEMORY\.md/);
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
  expect(prompt).toContain("sub-agent dispatched by Intercode");
  expect(prompt).toContain("Reporting back:");
  expect(prompt).toContain("only thing returned");
  expect(prompt).toContain("Change files with write_file/edit_file");
});

test("sub-agent prompt does not advertise tool_search (it gets the full toolset)", () => {
  const prompt = buildSubAgentSystemPrompt();
  expect(prompt).not.toContain("tool_search");
  expect(prompt).toContain("your full toolset");
});
