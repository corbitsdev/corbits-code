import { expect, test } from "bun:test";

import {
  buildAgentRole,
  buildAvailableTools,
  buildBudgetRules,
  buildChatSystemPrompt,
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

test("system prompt preserves core agent instructions", () => {
  const prompt = buildSystemPrompt();

  expect(prompt).toContain("autonomous coding agent");
  expect(prompt).toContain("Every turn must produce at least one tool_call");
  expect(prompt).toContain("Do not re-read a file you already read");
  expect(prompt).toContain("MUST call submit_output");
  expect(prompt).toContain("If tests are failing, you MUST NOT submit");
});
