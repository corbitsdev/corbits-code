import { test, expect } from "bun:test";
import { WorkflowRuntime } from "./runtime.js";
import { WorkflowCoordinator } from "./coordinator.js";
import type { CapabilityMap } from "./capabilities.js";
import type { Workflow } from "./types.js";

const empty: CapabilityMap = new Map();

const simple: Workflow = {
  name: "simple",
  description: "two steps",
  steps: [
    { id: "a", label: "A", prompt: "do a" },
    { id: "b", label: "B", prompt: "do b" },
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
  return [simple, withAgentStep].find((w) => w.name === name);
}

function coordDirective(rt: WorkflowRuntime): string {
  const directive = new WorkflowCoordinator(rt).directive();
  if (directive === null) throw new Error("expected an active directive");
  return directive;
}

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
