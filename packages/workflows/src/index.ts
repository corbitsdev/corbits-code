export type { Workflow, WorkflowStep, WorkflowPlugin, CapabilityName, StepType } from "./types.js";

export { buildFeature } from "./build-feature.js";
export { codeReview } from "./code-review.js";
export { improveDocs } from "./improve-docs.js";
export { scopeProject } from "./scope-project.js";
export { triageBug } from "./triage-bug.js";
export { updateTicket } from "./update-ticket.js";
export { writeTests } from "./write-tests.js";

import { buildFeature } from "./build-feature.js";
import { codeReview } from "./code-review.js";
import { improveDocs } from "./improve-docs.js";
import { scopeProject } from "./scope-project.js";
import { triageBug } from "./triage-bug.js";
import { updateTicket } from "./update-ticket.js";
import { writeTests } from "./write-tests.js";
import type { WorkflowPlugin } from "./types.js";

// The default workflow set shipped with intercode. Atomic workflows are listed
// before the composites that reference them so sub-workflow references resolve
// at registry load time.
export const plugin: WorkflowPlugin = {
  workflows: [
    updateTicket,
    improveDocs,
    writeTests,
    triageBug,
    codeReview,
    scopeProject,
    buildFeature,
  ],
};
