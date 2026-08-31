export type {
  Workflow,
  WorkflowStep,
  WorkflowPlugin,
  CapabilityName,
  StepType,
} from "./definition.js";

export type StepStatus = "pending" | "active" | "completed" | "skipped";

// Result of compare-and-advance: the matching current step moves the cursor;
// anything already behind it is already-complete; unknown and future ids are
// not-current. Callers report this instead of reconstructing the cursor.
export type WorkflowCompleteResult = "advanced" | "already-complete" | "not-current";

// One entry on the runtime call stack. The active frame is the last element;
// nested sub-workflows push new frames and pop on completion.
export interface WorkflowFrame {
  // Name of the workflow this frame is executing.
  workflow: string;
  // Index of the active step within that workflow's `steps`.
  stepIndex: number;
  // Per-step status, parallel to the workflow's `steps` array.
  statuses: StepStatus[];
}

// Serializable runtime state, persisted after every step transition so a run
// can resume mid-recipe (including mid sub-workflow chain).
export interface WorkflowState {
  stack: WorkflowFrame[];
  completed: boolean;
}

// Maximum sub-workflow nesting depth. Guards against accidental cycles
// (build-feature -> code-review -> build-feature -> ...).
export const MAX_WORKFLOW_DEPTH = 3;

// Valid slash-command / workflow name: lowercase alphanumerics separated by
// single hyphens. Validated at load time so every workflow yields a usable
// slash command.
const WORKFLOW_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidWorkflowName(name: string): boolean {
  return WORKFLOW_NAME_PATTERN.test(name);
}
