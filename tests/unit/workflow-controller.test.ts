import { test, expect } from "bun:test";
import "../helpers/workflows.js";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@intx/types/runtime";
import { initSessionDir } from "../../src/session/index.js";
import { WorkflowController } from "../../src/tui/workflow-controller.js";
import { WorkflowCoordinator } from "../../src/workflows/coordinator.js";
import { findWorkflow } from "../../src/workflows/index.js";
import { WorkflowRuntime } from "../../src/workflows/runtime.js";
import { flushWorkflowStateWrites, saveWorkflowState } from "../../src/workflows/state.js";

function tool(name: string): ToolDefinition {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

async function withController(
  tools: ToolDefinition[],
  fn: (
    c: WorkflowController,
    director: { coordinator: WorkflowCoordinator | undefined },
    cwd: string,
    home: string,
  ) => void | Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "wf-controller-"));
  const home = await mkdtemp(join(tmpdir(), "wf-controller-home-"));
  await initSessionDir(cwd, "session-1", home);
  const director = { coordinator: undefined as WorkflowCoordinator | undefined };
  const controller = new WorkflowController({
    cwd,
    emitter: new EventEmitter(),
    getSessionId: () => "session-1",
    getToolDefinitions: () => tools,
    getDirector: () => ({
      setWorkflowCoordinator: (c) => {
        director.coordinator = c;
      },
    }),
    home,
  });
  try {
    await fn(controller, director, cwd, home);
  } finally {
    await flushWorkflowStateWrites(cwd, "session-1", home);
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

test("starting a workflow attaches a coordinator to the director", async () => {
  await withController([], async (controller, director, _cwd) => {
    const msg = controller.start("review");
    expect(msg).toBe("Started review workflow.");
    expect(controller.isActive()).toBe(true);
    expect(director.coordinator).toBeInstanceOf(WorkflowCoordinator);
  });
});

test("starting an unknown workflow reports an error and stays inactive", async () => {
  await withController([], async (controller, _director, _cwd) => {
    expect(controller.start("nope")).toContain("No workflow");
    expect(controller.isActive()).toBe(false);
  });
});

test("replacing an active workflow requires a confirming second call", async () => {
  await withController([], async (controller, _director, _cwd) => {
    controller.start("review");
    const first = controller.start("build");
    expect(first).toContain("again to replace");
    expect(controller.status().name).toBe("review");
    const second = controller.start("build");
    expect(second).toBe("Started build workflow.");
    expect(controller.status().name).toBe("build");
  });
});

test("status reports capability connection and override state", async () => {
  await withController([tool("mcp__Linear__save_issue")], async (controller, _director, _cwd) => {
    const before = controller.status().capabilities.find((c) => c.name === "ticket-tracker");
    expect(before?.connected).toBe(true);
    expect(before?.disabled).toBe(false);
    controller.toggleCapability("ticket-tracker");
    const after = controller.status().capabilities.find((c) => c.name === "ticket-tracker");
    expect(after?.disabled).toBe(true);
  });
});

test("reset detaches the workflow", async () => {
  await withController([], async (controller, director, _cwd) => {
    controller.start("review");
    controller.reset();
    expect(controller.isActive()).toBe(false);
    expect(director.coordinator).toBeUndefined();
  });
});

test("directive uses submit_output with the current step id", async () => {
  await withController([], async (controller, director, _cwd) => {
    controller.start("build");
    const coordinator = director.coordinator!;
    expect(coordinator).toBeDefined();
    const directive = coordinator.directive();
    expect(directive).not.toBeNull();
    expect(directive).toContain("submit_output");
    expect(directive).toContain('"step":');
    expect(directive).not.toContain("advance_workflow");
  });
});

test("history() entry after workflow completion contains the workflow name and steps", async () => {
  await withController([], async (controller, _director, _cwd) => {
    controller.start("review");
    const coordinator = (controller as unknown as { coordinator: WorkflowCoordinator })
      .coordinator!;
    while (coordinator.isActive()) {
      const stepId = coordinator.currentStepId();
      expect(stepId).not.toBeNull();
      coordinator.handleToolDone("submit_output", { step: stepId }, false);
    }
    expect(controller.isActive()).toBe(false);
    const history = controller.history();
    expect(history).toHaveLength(1);
    expect(history[0]!.name).toBe("review");
    expect(history[0]!.steps.length).toBeGreaterThan(0);
  });
});

test("resume() uses the same completion listener as a fresh start", async () => {
  await withController([], async (controller, director, cwd, home) => {
    const workflow = findWorkflow("review");
    expect(workflow).toBeDefined();
    const runtime = new WorkflowRuntime(new Map());
    runtime.start(workflow!);
    await saveWorkflowState(cwd, "session-1", runtime.state(), home);

    await controller.resume();
    expect(controller.isActive()).toBe(true);
    const coordinator = director.coordinator!;
    while (coordinator.isActive()) {
      const stepId = coordinator.currentStepId();
      expect(stepId).not.toBeNull();
      coordinator.handleToolDone("submit_output", { step: stepId }, false);
    }
    expect(controller.history()).toHaveLength(1);
    expect(controller.history()[0]!.name).toBe("review");
  });
});

test("resume() restores an on-disk workflow snapshot for the session", async () => {
  await withController([], async (controller, director, cwd, home) => {
    const workflow = findWorkflow("review");
    expect(workflow).toBeDefined();
    const runtime = new WorkflowRuntime(new Map());
    runtime.start(workflow!);
    runtime.advance();
    await saveWorkflowState(cwd, "session-1", runtime.state(), home);

    await controller.resume();
    expect(controller.isActive()).toBe(true);
    expect(controller.status().name).toBe("review");
    expect(director.coordinator).toBeInstanceOf(WorkflowCoordinator);
  });
});
