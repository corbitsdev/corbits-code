// Public contract for workflow plugin authors. These types define everything
// needed to declare a workflow and publish it as a plugin package.

// Abstract capability a step depends on. Declared here so plugin authors can
// reference it without depending on the intercode runtime.
export type CapabilityName = "ticket-tracker" | "code-host" | "doc-search";

export type StepType = "standard" | "gate";

export type WorkflowStep = {
  // Stable identifier, unique within its workflow.
  id: string;
  // Human-readable label shown in the TUI step panel and status bar.
  label: string;
  // Instruction injected into the agent turn when this step becomes active.
  prompt?: string;
  // Capability this step requires. If unsatisfied, the step is skipped.
  capability?: CapabilityName;
  // Delegate this step to one or more sub-agents via the task tool.
  agent?: string | string[];
  // Skill the step should load before running its prompt.
  skill?: string;
  // Run a named workflow as a nested call.
  workflow?: string;
  // Optional steps are skipped silently when their capability is unsatisfied.
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

// The shape every workflow plugin package must export as its default export.
export type WorkflowPlugin = {
  workflows: Workflow[];
};
