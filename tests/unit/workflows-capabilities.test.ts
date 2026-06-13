import { test, expect } from "bun:test";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  detectCapabilities,
  resolveStep,
  CAPABILITIES,
} from "../../src/workflows/capabilities.js";
import type { WorkflowStep } from "../../src/workflows/types.js";

function tool(name: string): ToolDefinition {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

const linearTools = [
  tool("mcp__claude_ai_Linear__save_issue"),
  tool("mcp__claude_ai_Linear__list_issues"),
];
const githubTools = [tool("mcp__github__create_pull_request")];
const webTools = [tool("web_search"), tool("web_fetch")];

test("Linear tools satisfy ticket-tracker", () => {
  const map = detectCapabilities(linearTools);
  expect(map.has("ticket-tracker")).toBe(true);
  expect(map.get("ticket-tracker")).toHaveLength(2);
});

test("GitHub tools satisfy code-host", () => {
  const map = detectCapabilities(githubTools);
  expect(map.has("code-host")).toBe(true);
});

test("web tools satisfy doc-search", () => {
  const map = detectCapabilities(webTools);
  expect(map.has("doc-search")).toBe(true);
});

test("no matching tools means the capability is absent", () => {
  const map = detectCapabilities([tool("read_file"), tool("run_shell")]);
  expect(map.has("ticket-tracker")).toBe(false);
  expect(map.has("code-host")).toBe(false);
  expect(map.has("doc-search")).toBe(false);
});

test("unknown MCP servers are ignored, not errored", () => {
  expect(() =>
    detectCapabilities([tool("mcp__some_unknown_server__do_thing")]),
  ).not.toThrow();
});

test("an override disables a present capability", () => {
  const map = detectCapabilities(linearTools, new Set(["ticket-tracker"]));
  expect(map.has("ticket-tracker")).toBe(false);
});

test("resolveStep runs steps with no capability requirement", () => {
  const step: WorkflowStep = { id: "x", label: "X", prompt: "go" };
  const res = resolveStep(step, detectCapabilities([]));
  expect(res.runnable).toBe(true);
});

test("resolveStep marks a step non-runnable when its capability is unsatisfied", () => {
  const step: WorkflowStep = { id: "x", label: "X", capability: "ticket-tracker" };
  const res = resolveStep(step, detectCapabilities([]));
  expect(res.runnable).toBe(false);
  expect(res.skippedReason).toContain("ticket-tracker");
});

test("resolveStep returns the satisfying tools when runnable", () => {
  const step: WorkflowStep = { id: "x", label: "X", capability: "ticket-tracker" };
  const res = resolveStep(step, detectCapabilities(linearTools));
  expect(res.runnable).toBe(true);
  expect(res.tools).toHaveLength(2);
});

test("the capability registry is extensible by data alone", () => {
  for (const name of Object.keys(CAPABILITIES)) {
    expect(CAPABILITIES[name as keyof typeof CAPABILITIES].requiredTools.length).toBeGreaterThan(0);
  }
});
