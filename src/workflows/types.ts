export type {
  Workflow,
  WorkflowStep,
  WorkflowPlugin,
  CapabilityName,
} from "./definition.js";

export type StepStatus = "pending" | "active" | "completed" | "skipped";

// Compare-and-advance result: matching the current step advances; a step
// behind the cursor is already-complete; unknown and future ids are
// not-current.
export type WorkflowCompleteResult =
  | "advanced"
  | "already-complete"
  | "not-current";

// One entry on the runtime call stack. The active frame is last; nested
// sub-workflows push new frames and pop on completion.
export interface WorkflowFrame {
  // Workflow this frame executes.
  workflow: string;
  // Active step index within that workflow's `steps`.
  stepIndex: number;
  // Per-step status, parallel to the workflow's `steps`.
  statuses: StepStatus[];
}

// Serializable runtime state, persisted after every step transition so a run
// can resume mid-recipe, including mid sub-workflow chain.
export interface WorkflowState {
  stack: WorkflowFrame[];
  completed: boolean;
}

// Maximum sub-workflow nesting depth. Guards against accidental cycles
// (build-feature -> code-review -> build-feature -> ...).
export const MAX_WORKFLOW_DEPTH = 3;

// Valid slash-command / workflow name: lowercase alphanumerics separated by
// single hyphens. Validated at load time so every workflow is usable.
const WORKFLOW_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidWorkflowName(name: string): boolean {
  return WORKFLOW_NAME_PATTERN.test(name);
}
