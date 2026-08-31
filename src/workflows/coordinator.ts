import type { WorkflowRuntime } from "./runtime.js";
import type { WorkflowStep } from "./types.js";

// Bridges the workflow runtime and a director. A director consults the
// coordinator for the directive to inject into each turn's system prompt and
// hands it tool-completion events so it can advance the runtime. Keeping this
// logic here means both the headless and interactive directors share one
// implementation.
export class WorkflowCoordinator {
  constructor(
    private readonly runtime: WorkflowRuntime,
    // Persist runtime state after every transition so a run can resume
    // mid-recipe. Failures are swallowed — losing the workflow checkpoint must
    // not crash the agent loop.
    private readonly persist: () => void = () => {},
    // When true the workflow pauses after each step for user confirmation; the
    // directive tells the agent to gate via ask_operator before advancing.
    private readonly stepThrough = false,
  ) {}

  isActive(): boolean {
    return this.runtime.isActive();
  }

  isComplete(): boolean {
    return this.runtime.isComplete();
  }

  currentStepId(): string | null {
    return this.runtime.currentStep()?.id ?? null;
  }

  // True when the current step is a gate — the agent must pause and wait for
  // the operator. Used by the chat director to decide when to keep looping
  // autonomously vs. when to hand back to the user.
  currentStepIsGate(): boolean {
    return this.runtime.currentStep()?.type === "gate";
  }

  // The instruction block to append to the next turn's system prompt, or null
  // when no step is active. Includes the step ordinal, label, prompt, and the
  // delegation / completion guidance the step's fields imply.
  directive(): string | null {
    const step = this.runtime.currentStep();
    if (step === null) return null;
    const view = this.runtime.view();
    const ordinal = view !== null ? `${view.stepIndex + 1}/${view.total}` : "?";
    const lines = [
      `[WORKFLOW STEP ${ordinal}: ${step.label}]`,
      "",
      "The operator started this workflow via slash command; it is already running. Execute this step now.",
      "",
    ];
    if (step.prompt !== undefined) lines.push(step.prompt, "");
    for (const guidance of guidanceFor(step)) lines.push(guidance);
    if (this.stepThrough && step.type !== "gate") {
      lines.push(
        `Step-through mode is on: when this step is done, summarize it and call` +
          ` ask_operator to confirm before you advance.`,
      );
    }
    lines.push(
      `When this step is complete, call submit_output with { "step": "${step.id}" } to advance to the next step.`,
    );
    return lines.join("\n");
  }

  // Handle a completed tool call. Only a step-tagged submit_output can move
  // the runtime, and only via compare-and-advance against the current step.
  // Returns true when the runtime advanced (used by tests; the directors
  // already reset their idle counters on any tool call, so a workflow
  // advance is never seen as a stall). Duplicate or stale completions are
  // acknowledged here without moving the cursor.
  handleToolDone(name: string | undefined, args: unknown, isError: boolean): boolean {
    if (isError || !this.runtime.isActive()) return false;
    if (name !== "submit_output") return false;
    const stepId = stepIdOf(args);
    if (stepId === null) return false;
    if (this.runtime.complete(stepId) !== "advanced") return false;
    this.persist();
    return true;
  }
}

function stepIdOf(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const step = (args as Record<string, unknown>).step;
  return typeof step === "string" && step.length > 0 ? step : null;
}

function guidanceFor(step: WorkflowStep): string[] {
  const out: string[] = [];
  if (step.skill !== undefined) {
    out.push(`First load the ${step.skill} skill, then follow this step.`);
  }
  if (step.agent !== undefined) {
    const agents = Array.isArray(step.agent) ? step.agent : [step.agent];
    if (step.parallel === true && agents.length > 1) {
      out.push(
        `Delegate this step to these sub-agents in parallel via the task tool: ${agents.join(", ")}.` +
          ` Wait for all of them before advancing.`,
      );
    } else {
      out.push(`Delegate this step to the ${agents.join(", ")} sub-agent via the task tool.`);
    }
  }
  if (step.type === "gate") {
    out.push(
      `This is a gate: summarize what was done and ask the operator (ask_operator) to approve` +
        ` before you advance the workflow.`,
    );
  }
  return out;
}
