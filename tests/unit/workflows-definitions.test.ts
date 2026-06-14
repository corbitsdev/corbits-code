import { test, expect } from "bun:test";
import type { ToolDefinition } from "@intx/types/runtime";
import { WorkflowRuntime } from "../../src/workflows/runtime.js";
import { findWorkflow } from "../../src/workflows/index.js";
import { detectCapabilities, type CapabilityMap } from "../../src/workflows/capabilities.js";

function tool(name: string): ToolDefinition {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

const fullCaps: CapabilityMap = detectCapabilities([
  tool("mcp__Linear__save_issue"),
  tool("mcp__github__create_pull_request"),
  tool("web_search"),
]);

// Drive a workflow to completion, returning the ordered ids of the executable
// steps the runtime surfaced. Bounded to guard against a non-terminating recipe.
function drive(name: string, caps: CapabilityMap): string[] {
  const runtime = new WorkflowRuntime(caps);
  const workflow = findWorkflow(name);
  if (workflow === undefined) throw new Error(`missing ${name}`);
  runtime.start(workflow);
  const ids: string[] = [];
  for (let i = 0; i < 200 && runtime.currentStep() !== null; i++) {
    ids.push(runtime.currentStep()!.id);
    runtime.advance();
  }
  expect(runtime.isComplete()).toBe(true);
  return ids;
}

test("build-feature chains its atomic sub-workflows with full capabilities", () => {
  const ids = drive("build-feature", fullCaps);
  // Descends into scope-project (fetch-ticket), write-tests (baseline), the
  // inline implement step, code-review (get-diff), improve-docs, update-ticket,
  // and finally the human-approval gate.
  expect(ids).toContain("fetch-ticket");
  expect(ids).toContain("baseline");
  expect(ids).toContain("implement");
  expect(ids).toContain("get-diff");
  expect(ids).toContain("identify-docs");
  expect(ids).toContain("human-approval");
  expect(ids[ids.length - 1]).toBe("human-approval");
});

test("build-feature still completes with no capabilities, skipping ticket steps", () => {
  const ids = drive("build-feature", new Map());
  // The inline implement step and the tests/review atomics still run.
  expect(ids).toContain("implement");
  expect(ids).toContain("baseline");
  expect(ids).toContain("human-approval");
});

test("autoInvoke is set on build-feature for the coding profile", () => {
  expect(findWorkflow("build-feature")?.autoInvoke).toBe("coding");
});

test("every workflow drains to completion under full capabilities", () => {
  for (const name of ["update-ticket", "improve-docs", "write-tests", "triage-bug", "code-review", "scope-project", "build-feature"]) {
    expect(() => drive(name, fullCaps)).not.toThrow();
  }
});
