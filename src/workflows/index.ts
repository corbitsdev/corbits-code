import { plugin as defaultPlugin } from "@intercode/default-workflows";
import { isValidWorkflowName, type Workflow, type WorkflowPlugin } from "./types.js";

// Mutable registry. Starts with the default plugin and grows as external
// plugins are loaded from settings. All callers read from this array at
// call time, so plugins loaded after module init are visible to them.
export const WORKFLOWS: Workflow[] = [];

export function findWorkflow(name: string): Workflow | undefined {
  return WORKFLOWS.find((workflow) => workflow.name === name);
}

function registerWorkflowPlugin(plugin: WorkflowPlugin): void {
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

// Load and register workflow plugins listed in settings. Called once at
// startup before any workflow lookups occur.
export async function loadWorkflowPlugins(pluginSpecifiers: string[]): Promise<void> {
  for (const specifier of pluginSpecifiers) {
    let mod: unknown;
    try {
      mod = await import(specifier);
    } catch (err) {
      throw new Error(`Failed to load workflow plugin "${specifier}": ${String(err)}`);
    }
    const plugin =
      mod != null &&
      typeof mod === "object" &&
      "default" in mod &&
      mod.default != null &&
      typeof mod.default === "object" &&
      "workflows" in mod.default
        ? (mod.default as WorkflowPlugin)
        : "plugin" in (mod as Record<string, unknown>)
          ? ((mod as Record<string, unknown>).plugin as WorkflowPlugin)
          : undefined;
    if (plugin === undefined || !Array.isArray(plugin.workflows)) {
      throw new Error(
        `Workflow plugin "${specifier}" must export a WorkflowPlugin as "plugin" or as the default export.`,
      );
    }
    registerWorkflowPlugin(plugin);
  }
}

// Register the default plugin at module load so the registry is populated for
// any caller that does not go through loadWorkflowPlugins (e.g. tests).
registerWorkflowPlugin(defaultPlugin);

export type { Workflow, WorkflowStep, CapabilityName } from "./types.js";
