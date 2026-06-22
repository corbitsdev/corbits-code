import { isValidWorkflowName, type Workflow, type WorkflowPlugin } from "./types.js";

// Mutable registry populated by enabled workflow plugins at startup.
export const WORKFLOWS: Workflow[] = [];

export function findWorkflow(name: string): Workflow | undefined {
  return WORKFLOWS.find((workflow) => workflow.name === name);
}

export function registerWorkflowPlugin(plugin: WorkflowPlugin): void {
  for (const workflow of plugin.workflows) {
    if (!isValidWorkflowName(workflow.name)) {
      throw new Error(
        `Invalid workflow name "${workflow.name}": must be lowercase, hyphen-separated, no spaces.`,
      );
    }
    if (WORKFLOWS.some((w) => w.name === workflow.name)) {
      throw new Error(
        `Duplicate workflow name "${workflow.name}": a workflow with this name is already registered.`,
      );
    }
    WORKFLOWS.push(workflow);
  }
}

/** @internal test helper */
export function clearWorkflowRegistryForTests(): void {
  WORKFLOWS.length = 0;
}

export type { Workflow, WorkflowStep, CapabilityName } from "./types.js";