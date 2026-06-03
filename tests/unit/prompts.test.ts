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

test("plan decision rules include execute-direct and plan-first branches", () => {
  const rules = buildPlanDecisionRules();

  expect(rules).toContain("EXECUTE DIRECTLY");
  expect(rules).toContain("SUBMIT PLAN FIRST");
  expect(rules).toContain("3 or fewer files");
  expect(rules).toContain("4 or more files");
});

test("system prompt tells the agent to escalate blocked commands to the operator", () => {
  const prompt = buildSystemPrompt();

  expect(prompt).toContain("ask_operator");
  expect(prompt).toContain("blocked");
  expect(prompt).toMatch(/do not silently work around the block/i);
});

test("system prompt preserves core agent instructions", () => {
  const prompt = buildSystemPrompt();

  expect(prompt).toContain("autonomous coding agent");
  expect(prompt).toContain("Every turn must produce at least one tool_call");
  expect(prompt).toContain("Runtime limits are enforced by the tool layer");
  expect(prompt).toContain("File re-read prevention is enforced at the tool layer");
  expect(prompt).toContain("MUST call submit_output");
  expect(prompt).toContain("If tests are failing, you MUST NOT submit");
});
