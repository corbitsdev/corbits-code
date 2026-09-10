import { test, expect } from "bun:test";
import "../helpers/workflows.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@intx/types/runtime";
import { initSessionDir } from "../../src/session/index.js";
import { WorkflowCoordinator } from "../../src/workflows/coordinator.js";
import { WorkflowHost } from "../../src/workflows/host.js";
import { findWorkflow } from "../../src/workflows/index.js";
import { WorkflowRuntime } from "../../src/workflows/runtime.js";
import { flushWorkflowStateWrites, saveWorkflowState } from "../../src/workflows/state.js";

function tool(name: string): ToolDefinition {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

function drain(
  host: WorkflowHost,
  director: { coordinator: WorkflowCoordinator | undefined },
): void {
  while (host.isActive()) {
    const stepId = director.coordinator?.currentStepId();
    expect(stepId).not.toBeNull();
    expect(host.complete(stepId!)).toBe("advanced");
  }
}

async function withHost(
  tools: ToolDefinition[],
  fn: (
    host: WorkflowHost,
    director: { coordinator: WorkflowCoordinator | undefined },
    cwd: string,
    home: string,
  ) => void | Promise<void>,
  onChange?: () => void,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "wf-host-"));
  const home = await mkdtemp(join(tmpdir(), "wf-host-home-"));
  await initSessionDir(cwd, "session-1", home);
  const director = { coordinator: undefined as WorkflowCoordinator | undefined };
  const host = new WorkflowHost({
    cwd,
    getSessionId: () => "session-1",
    getToolDefinitions: () => tools,
    getDirector: () => ({
      setWorkflowCoordinator: (c) => {
        director.coordinator = c;
      },
    }),
    home,
    ...(onChange !== undefined ? { onChange } : {}),
  });
  try {
    await fn(host, director, cwd, home);
  } finally {
    await flushWorkflowStateWrites(cwd, "session-1", home);
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

test("starting a workflow attaches a coordinator to the director", async () => {
  await withHost([], async (host, director) => {
    const msg = host.start("review");
    expect(msg).toBe("Started review workflow.");
    expect(host.isActive()).toBe(true);
    expect(director.coordinator).toBeInstanceOf(WorkflowCoordinator);
  });
});

test("starting an unknown workflow reports an error and stays inactive", async () => {
  await withHost([], async (host) => {
    expect(host.start("nope")).toContain("No workflow");
    expect(host.isActive()).toBe(false);
  });
});

test("replacing an active workflow requires a confirming second call", async () => {
  await withHost([], async (host) => {
    host.start("review");
    const first = host.start("build");
    expect(first).toContain("again to replace");
    expect(host.status().name).toBe("review");
    const second = host.start("build");
    expect(second).toBe("Started build workflow.");
    expect(host.status().name).toBe("build");
  });
});

test("status reports capability connection and override state", async () => {
  await withHost([tool("mcp__Linear__save_issue")], async (host) => {
    const before = host.status().capabilities.find((c) => c.name === "ticket-tracker");
    expect(before?.connected).toBe(true);
    expect(before?.disabled).toBe(false);
    host.toggleCapability("ticket-tracker");
    const after = host.status().capabilities.find((c) => c.name === "ticket-tracker");
    expect(after?.disabled).toBe(true);
  });
});

test("reset detaches the workflow", async () => {
  await withHost([], async (host, director) => {
    host.start("review");
    host.reset();
    expect(host.isActive()).toBe(false);
    expect(director.coordinator).toBeUndefined();
  });
});

test("directive uses submit_output with the current step id", async () => {
  await withHost([], async (host, director) => {
    host.start("build");
    const coordinator = director.coordinator!;
    expect(coordinator).toBeDefined();
    const directive = coordinator.directive();
    expect(directive).not.toBeNull();
    expect(directive).toContain("submit_output");
    expect(directive).toContain('"step":');
    expect(directive).not.toContain("advance_workflow");
  });
});

test("complete() advances the current step and records history", async () => {
  await withHost([], async (host, director) => {
    host.start("review");
    drain(host, director);
    expect(host.isActive()).toBe(false);
    const history = host.history();
    expect(history).toHaveLength(1);
    expect(history[0]!.name).toBe("review");
    expect(history[0]!.steps.length).toBeGreaterThan(0);
  });
});

test("complete() is not-current when no workflow is active", async () => {
  await withHost([], async (host) => {
    expect(host.complete("any")).toBe("not-current");
  });
});

test("start notifies onChange", async () => {
  let changes = 0;
  await withHost(
    [],
    async (host) => {
      host.start("review");
      expect(changes).toBeGreaterThan(0);
    },
    () => {
      changes += 1;
    },
  );
});

test("resume() uses the same completion listener as a fresh start", async () => {
  await withHost([], async (host, director, cwd, home) => {
    const workflow = findWorkflow("review");
    expect(workflow).toBeDefined();
    const runtime = new WorkflowRuntime(new Map());
    runtime.start(workflow!);
    await saveWorkflowState(cwd, "session-1", runtime.state(), home);

    await host.resume();
    expect(host.isActive()).toBe(true);
    drain(host, director);
    expect(host.history()).toHaveLength(1);
    expect(host.history()[0]!.name).toBe("review");
  });
});

test("resume() restores an on-disk workflow snapshot for the session", async () => {
  await withHost([], async (host, director, cwd, home) => {
    const workflow = findWorkflow("review");
    expect(workflow).toBeDefined();
    const runtime = new WorkflowRuntime(new Map());
    runtime.start(workflow!);
    runtime.advance();
    await saveWorkflowState(cwd, "session-1", runtime.state(), home);

    await host.resume();
    expect(host.isActive()).toBe(true);
    expect(host.status().name).toBe("review");
    expect(director.coordinator).toBeInstanceOf(WorkflowCoordinator);
  });
});
