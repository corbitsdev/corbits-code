// Public contract for workflow plugin authors.

export type CapabilityName = "ticket-tracker" | "code-host" | "doc-search";

export type StepType = "standard" | "gate";

export type WorkflowStep = {
  id: string;
  label: string;
  prompt?: string;
  capability?: CapabilityName;
  agent?: string | string[];
  skill?: string;
  workflow?: string;
  optional?: boolean;
  parallel?: boolean;
  type?: StepType;
  profile?: string;
};

export type Workflow = {
  name: string;
  description: string;
  autoInvoke?: string;
  stepThrough?: boolean;
  autoAdvance?: boolean;
  steps: WorkflowStep[];
};

export type WorkflowPlugin = {
  workflows: Workflow[];
};