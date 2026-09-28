import { test, expect } from "bun:test";
import "../testkit/workflows.js";
import { WORKFLOWS, findWorkflow } from "./index.js";
import { isValidWorkflowName } from "./types.js";

test("every registered workflow has a unique, slash-command-valid name", () => {
  const names = WORKFLOWS.map((w) => w.name);
  expect(new Set(names).size).toBe(names.length);
  for (const name of names) {
    expect(isValidWorkflowName(name)).toBe(true);
  }
});

test("findWorkflow resolves by name and returns undefined for misses", () => {
  for (const workflow of WORKFLOWS) {
    expect(findWorkflow(workflow.name)).toBe(workflow);
  }
  expect(findWorkflow("does-not-exist")).toBeUndefined();
});

test("every sub-workflow reference resolves to a registered workflow", () => {
  for (const workflow of WORKFLOWS) {
    for (const step of workflow.steps) {
      if (step.workflow === undefined) continue;
      if (step.optional === true) continue;
      expect(findWorkflow(step.workflow)).toBeDefined();
    }
  }
});

test("isValidWorkflowName accepts hyphenated lowercase and rejects the rest", () => {
  expect(isValidWorkflowName("build-feature")).toBe(true);
  expect(isValidWorkflowName("scope")).toBe(true);
  expect(isValidWorkflowName("Build-Feature")).toBe(false);
  expect(isValidWorkflowName("build feature")).toBe(false);
  expect(isValidWorkflowName("build_feature")).toBe(false);
  expect(isValidWorkflowName("-build")).toBe(false);
  expect(isValidWorkflowName("build-")).toBe(false);
});
