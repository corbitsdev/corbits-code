import { expect, test } from "bun:test";

import {
  buildAgentRole,
  buildAvailableTools,
  buildBudgetRules,
  buildChatSystemPrompt,
  buildPlanDecisionRules,
  buildPlanRules,
  buildSubmitRules,
  buildSystemPrompt,
  buildToolCallDiscipline,
} from "../../src/prompts.js";

const sections = [
  buildAgentRole,
  buildToolCallDiscipline,
  buildSubmitRules,
  buildBudgetRules,
  buildPlanRules,
  buildPlanDecisionRules,
  buildAvailableTools,
];

test("prompt sections are non-empty", () => {
  for (const buildSection of sections) {
    expect(buildSection().trim().length).toBeGreaterThan(0);
  }
});

test("system prompt includes every section", () => {
  const prompt = buildSystemPrompt();

  expect(prompt).toContain(buildAgentRole());
  expect(prompt).toContain(buildToolCallDiscipline());
  expect(prompt).toContain(buildSubmitRules());
  expect(prompt).toContain(buildBudgetRules());
  expect(prompt).toContain(buildPlanRules());
  expect(prompt).toContain(buildPlanDecisionRules());
  expect(prompt).toContain(buildAvailableTools());
});

test("chat system prompt excludes submit rules", () => {
  const prompt = buildChatSystemPrompt();

  expect(prompt).not.toContain(buildSubmitRules());
  expect(prompt).not.toContain("submit_output");
});

test("full system prompt contains provided tool names", () => {
  const prompt = buildSystemPrompt(["first_tool", "second_tool"]);

  expect(prompt).toContain("first_tool");
  expect(prompt).toContain("second_tool");
});

test("plan decision always requires a plan, scaled by risk not file count", () => {
  const rules = buildPlanDecisionRules();

  expect(rules.toLowerCase()).toContain("submit a plan before you start");
  expect(rules.toLowerCase()).toContain("scale its depth to risk");
  expect(rules.toLowerCase()).toContain("blast radius");
  // The old rigid file-count thresholds must be gone.
  expect(rules).not.toContain("3 or fewer");
  expect(rules).not.toContain("4 or more");
});

test("system prompt tells the agent to escalate blocked commands to the operator", () => {
  const prompt = buildSystemPrompt();

  expect(prompt).toContain("ask_operator");
  expect(prompt).toContain("blocked");
  expect(prompt).toMatch(/don't work around the block/i);
});

test("system prompt preserves core agent instructions", () => {
  const prompt = buildSystemPrompt();

  expect(prompt).toContain("Intercode");
  expect(prompt).toMatch(/at least one tool call/i);
  expect(prompt).toContain("won't re-serve a file you already read");
  expect(prompt).toContain("submit_output is the only way to signal the task is complete");
  expect(prompt).toMatch(/never finish on a broken build, failing tests/i);
});
