import { isValidWorkflowName, type Workflow } from "./types.js";
import { updateTicket } from "./update-ticket.js";
import { improveDocs } from "./improve-docs.js";
import { writeTests } from "./write-tests.js";
import { triageBug } from "./triage-bug.js";
import { codeReview } from "./code-review.js";
import { scopeProject } from "./scope-project.js";

// The static registry of all built-in workflows. Adding a workflow is adding one
// import and one entry here — nothing else. The atomic workflows are registered
// before the composites that reference them so `findWorkflow` resolves nested
// references at module-load time.
export const WORKFLOWS: Workflow[] = [
  updateTicket,
  improveDocs,
  writeTests,
  triageBug,
  codeReview,
  scopeProject,
];

export function findWorkflow(name: string): Workflow | undefined {
  return WORKFLOWS.find((workflow) => workflow.name === name);
}

// Fail loudly at module load if a workflow name cannot become a valid slash
// command. This runs once at import time, turning a malformed name into an
// immediate startup error rather than a silently broken command.
for (const workflow of WORKFLOWS) {
  if (!isValidWorkflowName(workflow.name)) {
    throw new Error(
      `Invalid workflow name "${workflow.name}": must be lowercase, hyphen-separated, no spaces.`,
    );
  }
}

export type { Workflow, WorkflowStep, CapabilityName } from "./types.js";
