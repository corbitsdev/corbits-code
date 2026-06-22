import { beforeAll } from "bun:test";

import { workflowPlugin as linearWorkflows } from "../../plugins/linear-workflows/src/index.js";
import { clearWorkflowRegistryForTests, registerWorkflowPlugin } from "../../src/workflows/index.js";

export function installLinearWorkflowsForTests(): void {
  clearWorkflowRegistryForTests();
  registerWorkflowPlugin(linearWorkflows);
}

beforeAll(() => {
  installLinearWorkflowsForTests();
});