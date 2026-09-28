import { test, expect } from "bun:test";
import {
  WorkflowRuntime,
  type WorkflowEvent,
} from "../../src/workflows/runtime.js";
import { WorkflowCoordinator } from "../../src/workflows/coordinator.js";
import type { CapabilityMap } from "../../src/workflows/capabilities.js";
import type { ToolDefinition } from "@intx/types/runtime";
import type { Workflow } from "../../src/workflows/types.js";

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

const withAgentStep: Workflow = {
  name: "agented",
  description: "delegates a step",
  steps: [{ id: "a", label: "A", prompt: "do a", agent: "builder" }],
};

const withParallelAgents: Workflow = {
  name: "parallel-agents",
  description: "delegates a step in parallel",
  steps: [
    {
      id: "a",
      label: "A",
      prompt: "do a",
      agent: ["builder", "critic"],
      parallel: true,
    },
  ],
};

function resolver(name: string): Workflow | undefined {
  return [simple, withGatedStep, child, parent, withAgentStep].find(
    (w) => w.name === name,
  );
}

function collect(runtime: WorkflowRuntime): WorkflowEvent[] {
  const events: WorkflowEvent[] = [];
  runtime.on((e) => events.push(e));
  return events;
}

function coordDirective(rt: WorkflowRuntime): string {
  const directive = new WorkflowCoordinator(rt).directive();
  if (directive === null) throw new Error("expected an active directive");
  return directive;
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
  // The ticket step is skipped because ticket-tracker is absent.
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

test("coordinator directive includes the ordinal, label, prompt, and completion cue", () => {
  const rt = new WorkflowRuntime(empty, resolver);
  rt.start(simple);
  const coord = new WorkflowCoordinator(rt);
  const directive = coord.directive();
  expect(directive).toContain("[WORKFLOW STEP 1/2: A]");
  expect(directive).toContain("do a");
  expect(directive).toContain("submit_output");
  expect(directive).toContain('"step": "a"');
  expect(directive).not.toContain("advance_workflow");
});

test("coordinator directive defaults to mailbox collect when wait_agents is unmounted", () => {
  const rt = new WorkflowRuntime(empty, resolver);
  rt.start(withAgentStep);
  const directive = coordDirective(rt);
  expect(directive).toContain("mailbox mail");
  expect(directive).not.toContain("wait_agents");
});

test("coordinator directive keeps the wait_agents collect path when mounted", () => {
  const rt = new WorkflowRuntime(empty, resolver);
  rt.start(withAgentStep);
  const coord = new WorkflowCoordinator(rt, () => undefined, false, true);
  const directive = coord.directive();
  expect(directive).toContain("collect it with wait_agents");
});

test("coordinator parallel-agent guidance is mount-gated", () => {
  const parallelResolver = (n: string): Workflow | undefined =>
    n === "parallel-agents" ? withParallelAgents : undefined;
  const unmounted = new WorkflowRuntime(empty, parallelResolver);
  unmounted.start(withParallelAgents);
  expect(coordDirective(unmounted)).not.toContain("wait_agents");
  const mounted = new WorkflowRuntime(empty, parallelResolver);
  mounted.start(withParallelAgents);
  const coord = new WorkflowCoordinator(mounted, () => undefined, false, true);
  expect(coord.directive()).toContain("wait_agents");
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

test("coordinator advances on submit_output tagged with the current step", () => {
  const rt = new WorkflowRuntime(empty, resolver);
  rt.start(simple);
  const coord = new WorkflowCoordinator(rt);
  expect(coord.handleToolDone("submit_output", { step: "a" }, false)).toBe(
    true,
  );
  expect(rt.currentStep()?.id).toBe("b");
});

test("coordinator requires a step identifier to complete", () => {
  const rt = new WorkflowRuntime(empty, resolver);
  rt.start(simple);
  const coord = new WorkflowCoordinator(rt);
  expect(
    coord.handleToolDone("submit_output", { summary: "done" }, false),
  ).toBe(false);
  expect(coord.handleToolDone("submit_output", {}, false)).toBe(false);
  expect(rt.currentStep()?.id).toBe("a");
});

test("coordinator does not advance on advance_workflow", () => {
  const rt = new WorkflowRuntime(empty, resolver);
  rt.start(simple);
  const coord = new WorkflowCoordinator(rt);
  expect(coord.handleToolDone("advance_workflow", {}, false)).toBe(false);
  expect(rt.currentStep()?.id).toBe("a");
});

test("coordinator ignores submit_output tagged with a different step", () => {
  const rt = new WorkflowRuntime(empty, resolver);
  rt.start(simple);
  const coord = new WorkflowCoordinator(rt);
  expect(coord.handleToolDone("submit_output", { step: "zzz" }, false)).toBe(
    false,
  );
  expect(rt.currentStep()?.id).toBe("a");
});

test("coordinator treats completed steps as past and future ids as not past", () => {
  const rt = new WorkflowRuntime(empty, resolver);
  rt.start(simple);
  const coord = new WorkflowCoordinator(rt);
  expect(coord.isPastStep("a")).toBe(false);
  expect(coord.isPastStep("b")).toBe(false);
  expect(coord.handleToolDone("submit_output", { step: "a" }, false)).toBe(
    true,
  );
  expect(coord.isPastStep("a")).toBe(true);
  expect(coord.isPastStep("b")).toBe(false);
  expect(coord.isPastStep("zzz")).toBe(false);
});

test("duplicate and stale submit_output completions do not advance", () => {
  const rt = new WorkflowRuntime(empty, resolver);
  rt.start(simple);
  const coord = new WorkflowCoordinator(rt);
  expect(coord.handleToolDone("submit_output", { step: "a" }, false)).toBe(
    true,
  );
  expect(rt.currentStep()?.id).toBe("b");
  expect(coord.handleToolDone("submit_output", { step: "a" }, false)).toBe(
    false,
  );
  expect(rt.currentStep()?.id).toBe("b");
  expect(coord.handleToolDone("submit_output", { step: "b" }, false)).toBe(
    true,
  );
  expect(rt.isComplete()).toBe(true);
  expect(coord.handleToolDone("submit_output", { step: "b" }, false)).toBe(
    false,
  );
});

test("coordinator ignores errored tool calls", () => {
  const rt = new WorkflowRuntime(empty, resolver);
  rt.start(simple);
  const coord = new WorkflowCoordinator(rt);
  expect(coord.handleToolDone("submit_output", { step: "a" }, true)).toBe(
    false,
  );
  expect(rt.currentStep()?.id).toBe("a");
});

test("CL-8289 pin: capability skip emits reason and satisfied run lands on gated step", () => {
  const skipped = new WorkflowRuntime(empty, resolver);
  const skippedEvents = collect(skipped);
  skipped.start(withGatedStep);
  skipped.advance();
  expect(skipped.currentStep()?.id).toBe("c");
  const skip = skippedEvents.find(
    (e) => e.type === "step-skip" && e.step.id === "needs-ticket",
  );
  expect(skip?.type).toBe("step-skip");
  if (skip?.type === "step-skip") {
    expect(skip.reason).toBe("capability not satisfied: ticket-tracker");
  }

  const satisfied = new WorkflowRuntime(ticketTracker, resolver);
  satisfied.start(withGatedStep);
  satisfied.advance();
  expect(satisfied.currentStep()?.id).toBe("needs-ticket");
});

test("CL-8289 pin: sub-workflow descends parent to child then pops complete to p3", () => {
  const rt = new WorkflowRuntime(empty, resolver);
  const events = collect(rt);
  rt.start(parent);
  expect(rt.currentStep()?.id).toBe("p1");
  rt.advance();
  expect(rt.currentStep()?.id).toBe("c1");
  rt.advance();
  expect(rt.currentStep()?.id).toBe("p3");
  expect(events.map((e) => e.type)).toEqual([
    "step-start",
    "step-complete",
    "step-start",
    "step-complete",
    "step-complete",
    "step-start",
  ]);
});

test("CL-8289 pin: optional missing sub-workflow skips with not-found prefix", () => {
  const optionalMissing: Workflow = {
    name: "optional-missing",
    description: "optional absent child",
    steps: [{ id: "o", label: "O", workflow: "nope", optional: true }],
  };
  const rt = new WorkflowRuntime(empty, (n) =>
    n === "optional-missing" ? optionalMissing : undefined,
  );
  const events = collect(rt);
  rt.start(optionalMissing);
  expect(rt.isComplete()).toBe(true);
  const skip = events.find((e) => e.type === "step-skip");
  expect(skip?.type).toBe("step-skip");
  if (skip?.type === "step-skip") {
    expect(skip.reason.startsWith("sub-workflow not found: ")).toBe(true);
    expect(skip.reason).toBe("sub-workflow not found: nope");
  }
});

test("CL-8289 pin: required missing sub-workflow throws not-found text", () => {
  const requiredMissing: Workflow = {
    name: "required-missing",
    description: "required absent child",
    steps: [{ id: "r", label: "R", workflow: "nope" }],
  };
  const rt = new WorkflowRuntime(empty, (n) =>
    n === "required-missing" ? requiredMissing : undefined,
  );
  expect(() => rt.start(requiredMissing)).toThrow(
    'Sub-workflow "nope" not found in registry',
  );
});

test("CL-8289 pin: depth limit throws nesting text", () => {
  const cyclic: Workflow = {
    name: "cyclic",
    description: "calls itself",
    steps: [{ id: "loop", label: "Loop", workflow: "cyclic" }],
  };
  const rt = new WorkflowRuntime(empty, (n) =>
    n === "cyclic" ? cyclic : undefined,
  );
  expect(() => rt.start(cyclic)).toThrow(
    'Workflow nesting exceeded the limit of 3 (at "cyclic")',
  );
});

test("CL-8289 pin: two-step golden transcript", () => {
  const rt = new WorkflowRuntime(empty, resolver);
  const events = collect(rt);
  rt.start(simple);
  rt.advance();
  rt.advance();
  expect(rt.isComplete()).toBe(true);
  expect(events.map((e) => e.type)).toEqual([
    "step-start",
    "step-complete",
    "step-start",
    "step-complete",
    "workflow-complete",
  ]);
});
