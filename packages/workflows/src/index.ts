export type { Workflow, WorkflowStep, WorkflowPlugin, CapabilityName, StepType } from "./types.js";

export { plan } from "./plan.js";
export { scribe } from "./scribe.js";
export { build } from "./build.js";
export { review } from "./review.js";

import { plan } from "./plan.js";
import { scribe } from "./scribe.js";
import { build } from "./build.js";
import { review } from "./review.js";
import type { WorkflowPlugin } from "./types.js";

// The default workflow set shipped with intercode. Atomic workflows are listed
// before composites that reference them so sub-workflow references resolve at
// registry load time (review is referenced by build).
export const plugin: WorkflowPlugin = {
  workflows: [plan, scribe, review, build],
};
