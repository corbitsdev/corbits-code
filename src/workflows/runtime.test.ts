import { test, expect } from "bun:test";
import { WorkflowRuntime, type WorkflowEvent } from "./runtime.js";
import type { CapabilityMap } from "./capabilities.js";
import type { ToolDefinition } from "@intx/types/runtime";
import type { Workflow } from "./types.js";

function tool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
  };
}

const ticketTracker: CapabilityMap = new Map([
  ["ticket-tracker", [tool("mcp__Linear__save_issue")]],
]);
const empty: CapabilityMap = new Map();

const simple: Workflow = {
  name: "simple",
  description: "two steps",
  steps: [
    { id: "a", label: "A", prompt: "do a" },
    { id: "b", label: "B", prompt: "do b" },
  ],
};

const withGatedStep: Workflow = {
  name: "gated",
  description: "middle step needs a capability",
  steps: [
    { id: "a", label: "A", prompt: "do a" },
    {
      id: "needs-ticket",
      label: "Ticket",
      capability: "ticket-tracker",
      prompt: "update",
    },
    { id: "c", label: "C", prompt: "do c" },
  ],
};

const child: Workflow = {
  name: "child",
  description: "nested",
  steps: [{ id: "c1", label: "C1", prompt: "child work" }],
};

const parent: Workflow = {
  name: "parent",
  description: "calls child",
  steps: [
    { id: "p1", label: "P1", prompt: "before" },
    { id: "p2", label: "P2", workflow: "child" },
    { id: "p3", label: "P3", prompt: "after" },
  ],
};

function resolver(name: string): Workflow | undefined {
  return [simple, withGatedStep, child, parent].find((w) => w.name === name);
}

function collect(runtime: WorkflowRuntime): WorkflowEvent[] {
  const events: WorkflowEvent[] = [];
  runtime.on((e) => events.push(e));
  return events;
}

test("start lands on the first executable step", () => {
  const rt = new WorkflowRuntime(empty, resolver);
  rt.start(simple);
  expect(rt.currentStep()?.id).toBe("a");
});

test("advance moves to the next step and emits start/complete events", () => {
  const rt = new WorkflowRuntime(empty, resolver);
  const events = collect(rt);
  rt.start(simple);
  rt.advance();
  expect(rt.currentStep()?.id).toBe("b");
  expect(events.map((e) => e.type)).toEqual([
    "step-start",
    "step-complete",
    "step-start",
  ]);
  rt.advance();
  expect(rt.currentStep()).toBeNull();
  expect(events.some((e) => e.type === "workflow-complete")).toBe(true);
});

test("steps whose capability is unsatisfied are skipped, not injected", () => {
  const rt = new WorkflowRuntime(empty, resolver);
  const events = collect(rt);
  rt.start(withGatedStep);
  expect(rt.currentStep()?.id).toBe("a");
  rt.advance();
  // Ticket step skipped: ticket-tracker absent.
  expect(rt.currentStep()?.id).toBe("c");
  expect(
    events.some((e) => e.type === "step-skip" && e.step.id === "needs-ticket"),
  ).toBe(true);
});

test("a satisfied capability keeps the gated step in the sequence", () => {
  const rt = new WorkflowRuntime(ticketTracker, resolver);
  rt.start(withGatedStep);
  rt.advance();
  expect(rt.currentStep()?.id).toBe("needs-ticket");
});

test("sub-workflow chain runs the nested workflow then returns to the parent", () => {
  const rt = new WorkflowRuntime(empty, resolver);
  rt.start(parent);
  expect(rt.currentStep()?.id).toBe("p1");
  rt.advance();
  // Descends into child.
  expect(rt.currentStep()?.id).toBe("c1");
  rt.advance();
  // Child exhausted; returns to parent's next step.
  expect(rt.currentStep()?.id).toBe("p3");
  rt.advance();
  expect(rt.isComplete()).toBe(true);
});

test("state persists and resumes mid sub-workflow chain", () => {
  const rt = new WorkflowRuntime(empty, resolver);
  rt.start(parent);
  rt.advance(); // now inside child at c1
  const snapshot = rt.state();
  expect(snapshot.stack).toHaveLength(2);

  const resumed = new WorkflowRuntime(empty, resolver);
  resumed.restore(snapshot);
  expect(resumed.currentStep()?.id).toBe("c1");
  resumed.advance();
  expect(resumed.currentStep()?.id).toBe("p3");
});

test("nesting beyond the depth limit throws", () => {
  const cyclic: Workflow = {
    name: "cyclic",
    description: "calls itself",
    steps: [{ id: "loop", label: "Loop", workflow: "cyclic" }],
  };
  const rt = new WorkflowRuntime(empty, (n) =>
    n === "cyclic" ? cyclic : undefined,
  );
  expect(() => rt.start(cyclic)).toThrow(/nesting/);
});

test("runtime complete is a compare-and-advance against the current step", () => {
  const rt = new WorkflowRuntime(empty, resolver);
  rt.start(simple);
  expect(rt.complete("b")).toBe("not-current");
  expect(rt.complete("a")).toBe("advanced");
  expect(rt.currentStep()?.id).toBe("b");
  expect(rt.complete("a")).toBe("already-complete");
  expect(rt.currentStep()?.id).toBe("b");
  expect(rt.complete("zzz")).toBe("not-current");
  expect(rt.currentStep()?.id).toBe("b");
  expect(rt.complete("b")).toBe("advanced");
  expect(rt.isComplete()).toBe(true);
});
