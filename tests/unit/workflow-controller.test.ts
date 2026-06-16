import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@intx/types/runtime";
import { WorkflowController } from "../../src/tui/workflow-controller.js";
import { WorkflowCoordinator } from "../../src/workflows/coordinator.js";

function tool(name: string): ToolDefinition {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

async function withController(
  tools: ToolDefinition[],
  fn: (c: WorkflowController, director: { coordinator: WorkflowCoordinator | undefined }) => void | Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "wf-controller-"));
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
  });
  try {
    await fn(controller, director);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("starting a workflow attaches a coordinator to the director", async () => {
  await withController([], async (controller, director) => {
    const msg = controller.start("review");
    expect(msg).toBe("Started review workflow.");
    expect(controller.isActive()).toBe(true);
    expect(director.coordinator).toBeInstanceOf(WorkflowCoordinator);
  });
});

test("starting an unknown workflow reports an error and stays inactive", async () => {
  await withController([], async (controller) => {
    expect(controller.start("nope")).toContain("No workflow");
    expect(controller.isActive()).toBe(false);
  });
});

test("replacing an active workflow requires a confirming second call", async () => {
  await withController([], async (controller) => {
    controller.start("review");
    const first = controller.start("build");
    expect(first).toContain("again to replace");
    expect(controller.status().name).toBe("review");
    const second = controller.start("build");
    expect(second).toBe("Started build workflow.");
    expect(controller.status().name).toBe("build");
  });
});

test("autoInvoke starts only when nothing is active", async () => {
  await withController([], async (controller) => {
    expect(controller.autoInvoke("build")).toContain("Auto-started");
    expect(controller.autoInvoke("review")).toBeNull();
  });
});

test("status reports capability connection and override state", async () => {
  await withController([tool("mcp__Linear__save_issue")], async (controller) => {
    const before = controller.status().capabilities.find((c) => c.name === "ticket-tracker");
    expect(before?.connected).toBe(true);
    expect(before?.disabled).toBe(false);
    controller.toggleCapability("ticket-tracker");
    const after = controller.status().capabilities.find((c) => c.name === "ticket-tracker");
    expect(after?.disabled).toBe(true);
  });
});

test("reset detaches the workflow", async () => {
  await withController([], async (controller, director) => {
    controller.start("review");
    controller.reset();
    expect(controller.isActive()).toBe(false);
    expect(director.coordinator).toBeUndefined();
  });
});
