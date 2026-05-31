import { expect, test } from "bun:test";

import { createCodingDirector, submitPlanDefinition, submitOutputDefinition } from "./director.js";
import { buildSystemPrompt, buildChatSystemPrompt } from "./prompts.js";

const minimalToolDefinitions = [submitPlanDefinition, submitOutputDefinition];

test("buildSystemPrompt wires into createCodingDirector without error", () => {
  const prompt = buildSystemPrompt();
  expect(() => createCodingDirector(prompt, minimalToolDefinitions)).not.toThrow();
});

test("buildChatSystemPrompt wires into createCodingDirector without error", () => {
  const prompt = buildChatSystemPrompt();
  expect(() => createCodingDirector(prompt, minimalToolDefinitions)).not.toThrow();
});

test("director created from buildSystemPrompt starts in expected initial state", () => {
  const director = createCodingDirector(buildSystemPrompt(), minimalToolDefinitions);
  const state = director.getState();

  expect(state.planSubmitted).toBe(false);
  expect(state.turnsUsed).toBe(0);
  expect(state.plan).toEqual([]);
});

test("buildSystemPrompt includes submit_plan and submit_output tool names", () => {
  const prompt = buildSystemPrompt();

  expect(prompt).toContain("submit_plan");
  expect(prompt).toContain("submit_output");
});

test("buildChatSystemPrompt excludes submit_plan and submit_output tool names", () => {
  const prompt = buildChatSystemPrompt();

  expect(prompt).not.toContain("submit_plan");
  expect(prompt).not.toContain("submit_output");
});

test("director created from buildSystemPrompt with custom tools reflects those tools", () => {
  const customTools = ["read_file", "write_file", "submit_plan", "submit_output"];
  const prompt = buildSystemPrompt(customTools);
  const director = createCodingDirector(prompt, minimalToolDefinitions);

  expect(director).toBeDefined();
  expect(prompt).toContain("read_file");
  expect(prompt).toContain("write_file");
});
