// Workflows are named, ordered recipes the coding agent follows step by step.
// They live here as first-class TypeScript — not user plugins, not YAML — and
// ship with Intercode. Definitions are validated at compile time with the
// `satisfies Workflow` pattern, so a malformed workflow fails the build rather
// than at runtime. See docs/ARCHITECTURE.md for how the runtime drives them.

// Abstract capability a step depends on. A step declares a capability rather
// than a concrete tool name; the capability map (capabilities.ts) decides which
// connected tools satisfy it. Capability names are the stable contract — tool
// names behind them are implementation details.
export type CapabilityName = "ticket-tracker" | "code-host" | "doc-search";

// A gate step pauses the workflow and waits for the user before advancing.
// Standard steps run to completion and advance automatically.
export type StepType = "standard" | "gate";

export type WorkflowStep = {
  // Stable identifier, unique within its workflow. Used as the completion
  // signal key (submit_output { step: id }) and for state persistence.
  id: string;
  // Human-readable label shown in the TUI step panel and status bar.
  label: string;
  // Instruction injected into the agent turn when this step becomes active.
  // Omitted for pure sub-workflow steps, whose work is the nested workflow.
  prompt?: string;
  // Capability this step requires. If unsatisfied, the step is skipped.
  capability?: CapabilityName;
  // Delegate this step to one or more sub-agents via the task tool. An array
  // combined with `parallel: true` fans out concurrently.
  agent?: string | string[];
  // Skill the step should load before running its prompt (e.g. "scribe").
  skill?: string;
  // Run a named workflow as a nested call. The runtime pushes it onto the call
  // stack, runs it to completion, then advances this step.
  workflow?: string;
  // Optional steps are skipped silently when their capability is unsatisfied or
  // their sub-workflow is missing, rather than blocking the recipe.
  optional?: boolean;
  // Fan the `agent` array out concurrently instead of sequentially.
  parallel?: boolean;
  // Step kind. Defaults to "standard" when omitted.
  type?: StepType;
};

export type Workflow = {
  // Name doubles as the slash command (/build-feature) and the registry key.
  // Must be a valid slash-command token: lowercase, hyphen-separated, no spaces.
  name: string;
  description: string;
  // Agent profile name that auto-starts this workflow on session start.
  autoInvoke?: string;
  // Pause after every step and wait for the user before advancing.
  stepThrough?: boolean;
  steps: WorkflowStep[];
};

export type StepStatus = "pending" | "active" | "completed" | "skipped";

// One entry on the runtime call stack. The active frame is the last element;
// nested sub-workflows push new frames and pop on completion.
export type WorkflowFrame = {
  // Name of the workflow this frame is executing.
  workflow: string;
  // Index of the active step within that workflow's `steps`.
  stepIndex: number;
  // Per-step status, parallel to the workflow's `steps` array.
  statuses: StepStatus[];
};

// Serializable runtime state, persisted after every step transition so a run
// can resume mid-recipe (including mid sub-workflow chain).
export type WorkflowState = {
  stack: WorkflowFrame[];
  completed: boolean;
};

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
