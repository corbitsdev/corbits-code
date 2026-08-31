import type { CapabilityMap } from "./capabilities.js";
import { resolveStep } from "./capabilities.js";
import { findWorkflow } from "./index.js";
import {
  MAX_WORKFLOW_DEPTH,
  type StepStatus,
  type Workflow,
  type WorkflowFrame,
  type WorkflowState,
  type WorkflowStep,
  type WorkflowCompleteResult,
} from "./types.js";

export type WorkflowEvent =
  | { type: "step-start"; workflow: string; step: WorkflowStep; index: number; total: number }
  | { type: "step-complete"; workflow: string; step: WorkflowStep }
  | { type: "step-skip"; workflow: string; step: WorkflowStep; reason: string }
  | { type: "workflow-complete"; workflow: string };

export type WorkflowListener = (event: WorkflowEvent) => void;

// A flattened view of the active frame's steps for the TUI step panel.
export interface WorkflowView {
  name: string;
  stepIndex: number;
  total: number;
  label: string;
  steps: { step: WorkflowStep; status: StepStatus }[];
}

type Resolver = (name: string) => Workflow | undefined;

// Drives step-by-step execution on top of the existing agent loop. The runtime
// owns the call stack and step statuses; it decides which step is current and
// what runs next, while the director performs the actual work (prompt injection,
// sub-agent fan-out). Steps whose capability is unsatisfied are skipped; steps
// that name a sub-workflow push a nested frame onto the stack.
export class WorkflowRuntime {
  private stack: WorkflowFrame[] = [];
  private done = false;
  private readonly listeners = new Set<WorkflowListener>();

  constructor(
    private capabilities: CapabilityMap,
    private readonly resolve: Resolver = findWorkflow,
  ) {}

  // Replace the capability map mid-run. Steps already settled keep their status;
  // not-yet-reached steps are resolved against the new map (so toggling a
  // capability off in the TUI skips its remaining steps).
  setCapabilities(capabilities: CapabilityMap): void {
    this.capabilities = capabilities;
  }

  on(listener: WorkflowListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: WorkflowEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  start(workflow: Workflow): void {
    this.stack = [frameFor(workflow)];
    this.done = false;
    this.settle();
  }

  isActive(): boolean {
    return this.stack.length > 0 && !this.done;
  }

  isComplete(): boolean {
    return this.done;
  }

  private topFrame(): WorkflowFrame | undefined {
    return this.stack[this.stack.length - 1];
  }

  private workflowOf(frame: WorkflowFrame): Workflow {
    const workflow = this.resolve(frame.workflow);
    if (workflow === undefined) {
      throw new Error(`Workflow "${frame.workflow}" not found in registry`);
    }
    return workflow;
  }

  // The executable step the director should run now, or null when complete.
  currentStep(): WorkflowStep | null {
    if (this.done) return null;
    const frame = this.topFrame();
    if (frame === undefined) return null;
    const workflow = this.workflowOf(frame);
    return workflow.steps[frame.stepIndex] ?? null;
  }

  // Compare-and-advance against the current step. Matching `stepId` advances
  // atomically (check and move happen in this call). A step already behind the
  // cursor is already-complete; a future, unknown, or inactive id is
  // not-current. Neither acknowledged case moves the cursor, so a retry cannot
  // skip ahead.
  complete(stepId: string): WorkflowCompleteResult {
    const current = this.currentStep();
    if (current !== null && current.id === stepId) {
      this.advance();
      return "advanced";
    }
    const view = this.view();
    if (view !== null) {
      const idx = view.steps.findIndex((s) => s.step.id === stepId);
      if (idx !== -1 && idx < view.stepIndex) return "already-complete";
    }
    return "not-current";
  }

  // Mark the current step complete and move to the next runnable step. Pops
  // finished sub-workflow frames and descends into sub-workflow references as
  // needed. Emits step-complete for the step left behind.
  advance(): void {
    if (this.done) return;
    const frame = this.topFrame();
    if (frame === undefined) return;
    const workflow = this.workflowOf(frame);
    const step = workflow.steps[frame.stepIndex];
    if (step !== undefined) {
      frame.statuses[frame.stepIndex] = "completed";
      this.emit({ type: "step-complete", workflow: workflow.name, step });
    }
    frame.stepIndex += 1;
    this.settle();
  }

  // Advance the call stack until the top frame is sitting on an executable step,
  // popping exhausted frames and descending into sub-workflows. Emits step-skip
  // for skipped steps and step-start for the executable step it lands on.
  private settle(): void {
    for (;;) {
      const frame = this.topFrame();
      if (frame === undefined) {
        this.done = true;
        return;
      }
      const workflow = this.workflowOf(frame);

      if (frame.stepIndex >= workflow.steps.length) {
        // This frame is exhausted. Pop it; if it was a sub-workflow, the parent
        // step that invoked it is now complete, so advance the parent.
        this.stack.pop();
        const parent = this.topFrame();
        if (parent === undefined) {
          this.done = true;
          this.emit({ type: "workflow-complete", workflow: workflow.name });
          return;
        }
        const parentWorkflow = this.workflowOf(parent);
        const parentStep = parentWorkflow.steps[parent.stepIndex];
        if (parentStep !== undefined) {
          parent.statuses[parent.stepIndex] = "completed";
          this.emit({ type: "step-complete", workflow: parentWorkflow.name, step: parentStep });
        }
        parent.stepIndex += 1;
        continue;
      }

      const step = workflow.steps[frame.stepIndex];
      if (step === undefined) {
        frame.stepIndex += 1;
        continue;
      }

      const resolution = resolveStep(step, this.capabilities);
      if (!resolution.runnable) {
        frame.statuses[frame.stepIndex] = "skipped";
        this.emit({
          type: "step-skip",
          workflow: workflow.name,
          step,
          reason: resolution.skippedReason ?? "not runnable",
        });
        frame.stepIndex += 1;
        continue;
      }

      if (step.workflow !== undefined) {
        const nested = this.resolve(step.workflow);
        if (nested === undefined) {
          if (step.optional === true) {
            frame.statuses[frame.stepIndex] = "skipped";
            this.emit({
              type: "step-skip",
              workflow: workflow.name,
              step,
              reason: `sub-workflow not found: ${step.workflow}`,
            });
            frame.stepIndex += 1;
            continue;
          }
          throw new Error(`Sub-workflow "${step.workflow}" not found in registry`);
        }
        if (this.stack.length >= MAX_WORKFLOW_DEPTH) {
          throw new Error(
            `Workflow nesting exceeded the limit of ${MAX_WORKFLOW_DEPTH} (at "${step.workflow}")`,
          );
        }
        frame.statuses[frame.stepIndex] = "active";
        this.stack.push(frameFor(nested));
        continue;
      }

      // Landed on an executable step.
      frame.statuses[frame.stepIndex] = "active";
      this.emit({
        type: "step-start",
        workflow: workflow.name,
        step,
        index: frame.stepIndex,
        total: workflow.steps.length,
      });
      return;
    }
  }

  state(): WorkflowState {
    return {
      stack: this.stack.map((frame) => ({
        workflow: frame.workflow,
        stepIndex: frame.stepIndex,
        statuses: [...frame.statuses],
      })),
      completed: this.done,
    };
  }

  // Reconstruct the runtime from persisted state for resume. Does not re-emit
  // events or re-settle — the stack is restored exactly as saved.
  restore(state: WorkflowState): void {
    this.stack = state.stack.map((frame) => ({
      workflow: frame.workflow,
      stepIndex: frame.stepIndex,
      statuses: [...frame.statuses],
    }));
    this.done = state.completed;
  }

  // A view of the active frame for the TUI: name, position, and per-step status.
  view(): WorkflowView | null {
    const frame = this.topFrame();
    if (frame === undefined) return null;
    const workflow = this.workflowOf(frame);
    const current = workflow.steps[frame.stepIndex];
    return {
      name: workflow.name,
      stepIndex: frame.stepIndex,
      total: workflow.steps.length,
      label: current?.label ?? (this.done ? "complete" : ""),
      steps: workflow.steps.map((step, i) => ({
        step,
        status: frame.statuses[i] ?? "pending",
      })),
    };
  }
}

function frameFor(workflow: Workflow): WorkflowFrame {
  return {
    workflow: workflow.name,
    stepIndex: 0,
    statuses: workflow.steps.map(() => "pending" as StepStatus),
  };
}
