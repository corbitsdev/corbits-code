import { test, expect } from "bun:test";
import "../helpers/workflows.js";
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

test("build workflow chains review as a sub-workflow with full capabilities", () => {
  const ids = drive("build", fullCaps);
  // Descends into review (core-review, synthesize), and the gate at the end.
  expect(ids).toContain("fetch-ticket");
  expect(ids).toContain("implement");
  expect(ids).toContain("core-review");
  expect(ids).toContain("synthesize");
  expect(ids).toContain("gate");
  expect(ids[ids.length - 1]).toBe("gate");
});

test("build workflow completes with no capabilities, skipping ticket steps", () => {
  const ids = drive("build", new Map());
  expect(ids).toContain("implement");
  expect(ids).toContain("gate");
});

test("every sample workflow drains to completion under full capabilities", () => {
  for (const name of ["scope", "review", "build"]) {
    expect(() => drive(name, fullCaps)).not.toThrow();
  }
});
