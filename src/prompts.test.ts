import { expect, test } from "bun:test";

import { createCodingDirector, submitPlanDefinition, submitOutputDefinition } from "./director.js";
import {
  buildAgentRole,
  buildAvailableTools,
  buildBudgetRules,
  buildChatSystemPrompt,
  buildFewShot,
  buildPlanDecisionRules,
  buildPlanRules,
  buildSelfVerification,
  buildStyleRules,
  buildSubmitRules,
  buildSystemPrompt,
  buildToolCallDiscipline,
} from "./prompts.js";

const minimalToolDefinitions = [submitPlanDefinition, submitOutputDefinition];

test("buildSystemPrompt wires into createCodingDirector without error", () => {
  const prompt = buildSystemPrompt();
  expect(() => createCodingDirector(prompt, minimalToolDefinitions)).not.toThrow();
});

test("buildChatSystemPrompt wires into createCodingDirector without error", () => {
  const prompt = buildChatSystemPrompt();
  expect(() => createCodingDirector(prompt, minimalToolDefinitions)).not.toThrow();
});

test("buildSystemPrompt includes all sections in order", () => {
  const prompt = buildSystemPrompt();
  const role = buildAgentRole();
  const discipline = buildToolCallDiscipline();
  const submit = buildSubmitRules();
  const budget = buildBudgetRules();
  const plan = buildPlanRules();
  const tools = buildAvailableTools();

  expect(prompt.indexOf(role)).toBeLessThan(prompt.indexOf(discipline));
  expect(prompt.indexOf(discipline)).toBeLessThan(prompt.indexOf(submit));
  expect(prompt.indexOf(submit)).toBeLessThan(prompt.indexOf(budget));
  expect(prompt.indexOf(budget)).toBeLessThan(prompt.indexOf(plan));
  expect(prompt.indexOf(plan)).toBeLessThan(prompt.indexOf(tools));
});

test("buildSystemPrompt separates sections with double newlines", () => {
  const prompt = buildSystemPrompt();
  // Sections are joined with \n\n — verify at least one boundary exists
  expect(prompt).toContain(buildAgentRole() + "\n\n" + buildToolCallDiscipline());
  expect(prompt).toContain(buildToolCallDiscipline() + "\n\n" + buildSubmitRules());
});

test("buildSystemPrompt includes submit_plan and submit_output in tool list", () => {
  const prompt = buildSystemPrompt();
  expect(prompt).toContain("submit_plan");
  expect(prompt).toContain("submit_output");
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

test("plan decision is framed by risk, not a hard file count", () => {
  const decision = buildPlanDecisionRules();
  expect(decision.toLowerCase()).toContain("risk and reversibility");
  // The old rigid thresholds must be gone.
  expect(decision).not.toContain("3 or fewer");
  expect(decision).not.toContain("4 or more");
});

test("chat prompt is Intercode and holds the same code standards", () => {
  const prompt = buildChatSystemPrompt();
  expect(prompt).toContain("Intercode");
  expect(prompt.toLowerCase()).not.toContain("you are a helpful coding assistant");
  expect(prompt).toContain(buildStyleRules());
});
