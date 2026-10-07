import { join } from "node:path";
import type { ToolDefinition } from "@intx/types/runtime";

import { sessionDir } from "../session/index.js";
import { errorMessage } from "../agent/error-message.js";
import {
  CAPABILITIES,
  detectCapabilities,
  type CapabilityMap,
} from "./capabilities.js";
import { WorkflowCoordinator } from "./coordinator.js";
import { findWorkflow, WORKFLOWS } from "./index.js";
import { WorkflowRuntime, type WorkflowEvent } from "./runtime.js";
import {
  loadWorkflowState,
  saveWorkflowState,
  warnWorkflowPersistenceFailure,
} from "./state.js";
import type {
  CapabilityName,
  StepStatus,
  Workflow,
  WorkflowCompleteResult,
} from "./types.js";

export interface CapabilityStatus {
  name: CapabilityName;
  description: string;
  connected: boolean;
  disabled: boolean;
  source: string | undefined;
}

export interface WorkflowStepStatus {
  label: string;
  status: StepStatus;
  capability: CapabilityName | undefined;
}

export interface WorkflowStatus {
  active: boolean;
  name: string | undefined;
  stepIndex: number;
  total: number;
  label: string;
  steps: WorkflowStepStatus[];
  capabilities: CapabilityStatus[];
  completedAt?: number;
}

export interface WorkflowHostState {
  current: WorkflowStatus;
  history: WorkflowStatus[];
}

type SetCoordinator = (coordinator: WorkflowCoordinator | undefined) => void;

export interface WorkflowHostArgs {
  cwd: string;
  getSessionId: () => string;
  getToolDefinitions: () => ToolDefinition[];
  // The live chat director; the workflow coordinator attaches to it when a
  // workflow starts. Optional so directors without workflow support stay
  // valid — every attach point presence-checks before calling.
  getDirector: () => { setWorkflowCoordinator?: SetCoordinator } | undefined;
  // Overrides the state-tree home; tests pass a sandboxed dir so
  // persist()/resume() never touch ~/.corbits.
  home?: string;
  onChange?: () => void;
}

// Owns the workflow lifecycle; UI subscribes via onChange and renders status().
export class WorkflowHost {
  private runtime: WorkflowRuntime | undefined;
  private coordinator: WorkflowCoordinator | undefined;
  private overrides = new Set<CapabilityName>();
  private pendingReplace: string | undefined;
  private completedWorkflows: WorkflowStatus[] = [];
  // Last active status snapshot, used to fill history once workflow-complete
  // fires after isActive() is already false.
  private lastActiveStatus: WorkflowStatus | undefined;

  constructor(private readonly args: WorkflowHostArgs) {}

  // Re-attach the active coordinator to a rebuilt director; with no active
  // workflow this only clears stale state.
  reattach(): void {
    this.args.getDirector()?.setWorkflowCoordinator?.(this.coordinator);
  }

  // Drop the active workflow and history (on /clear).
  reset(): void {
    this.runtime = undefined;
    this.coordinator = undefined;
    this.pendingReplace = undefined;
    this.completedWorkflows = [];
    this.lastActiveStatus = undefined;
    this.args.getDirector()?.setWorkflowCoordinator?.(undefined);
    this.notify();
  }

  history(): WorkflowStatus[] {
    return this.completedWorkflows;
  }

  private capabilityMap(): CapabilityMap {
    return detectCapabilities(this.args.getToolDefinitions(), this.overrides);
  }

  isActive(): boolean {
    return this.runtime?.isActive() === true;
  }

  complete(stepId: string): WorkflowCompleteResult {
    return this.coordinator?.complete(stepId) ?? "not-current";
  }

  list(): { name: string; description: string }[] {
    return WORKFLOWS.map((w) => ({ name: w.name, description: w.description }));
  }

  private notify(): void {
    const current = this.status();
    if (current.active) this.lastActiveStatus = current;
    this.args.onChange?.();
  }

  private persist(): void {
    const runtime = this.runtime;
    if (runtime === undefined) return;
    const sessionId = this.args.getSessionId();
    void saveWorkflowState(
      this.args.cwd,
      sessionId,
      runtime.state(),
      this.args.home,
    ).catch((err: unknown) => {
      const reason = errorMessage(err);
      warnWorkflowPersistenceFailure(
        join(
          sessionDir(this.args.cwd, sessionId, this.args.home),
          "workflow.json",
        ),
        reason,
      );
    });
  }

  private attachRuntime(
    workflow: Workflow,
    restore?: boolean,
  ): WorkflowRuntime {
    const runtime = new WorkflowRuntime(this.capabilityMap());
    const coordinator = new WorkflowCoordinator(
      runtime,
      () => {
        this.persist();
        this.notify();
      },
      workflow.stepThrough === true,
      // Directive collect copy follows the live surface: wait_agents on exec
      // primary, mailbox mail where unmounted (TUI, nested).
      this.args
        .getToolDefinitions()
        .some((definition) => definition.name === "wait_agents"),
    );
    this.listen(runtime);
    this.runtime = runtime;
    this.coordinator = coordinator;
    this.args.getDirector()?.setWorkflowCoordinator?.(coordinator);
    if (restore !== true) {
      runtime.start(workflow);
      this.persist();
      this.notify();
    }
    return runtime;
  }

  // Shared by start and resume so both record history identically.
  private listen(runtime: WorkflowRuntime): void {
    runtime.on((event: WorkflowEvent) => {
      if (event.type === "workflow-complete") {
        // runtime.done is already true when this fires, so status() is empty;
        // use the last active snapshot.
        const snapshot = this.lastActiveStatus;
        if (snapshot !== undefined) {
          this.completedWorkflows.push({
            ...snapshot,
            active: false,
            completedAt: Date.now(),
          });
        }
      }
      this.persist();
      this.notify();
    });
  }

  // Start a workflow by name. An active workflow asks for confirmation; the
  // same name again replaces it.
  start(name: string): string {
    const workflow = findWorkflow(name);
    if (workflow === undefined) {
      const names = WORKFLOWS.map((w) => `/${w.name}`).join(", ");
      return `No workflow named "${name}". Available: ${names}.`;
    }
    if (this.isActive()) {
      if (this.pendingReplace !== name) {
        this.pendingReplace = name;
        return `A workflow is already active. Run /${name} again to replace it.`;
      }
    }
    this.pendingReplace = undefined;
    this.attachRuntime(workflow);
    return `Started ${name} workflow.`;
  }

  // Restore a persisted workflow for the current session, if any.
  async resume(): Promise<void> {
    const state = await loadWorkflowState(
      this.args.cwd,
      this.args.getSessionId(),
      this.args.home,
    );
    if (state === null || state.completed || state.stack.length === 0) return;
    const rootName = state.stack[0]?.workflow;
    const workflow =
      rootName !== undefined ? findWorkflow(rootName) : undefined;
    if (workflow === undefined) return;
    const runtime = this.attachRuntime(workflow, true);
    runtime.restore(state);
    this.notify();
  }

  // Toggle a capability for this run. Affects not-yet-reached steps and the
  // displayed status.
  toggleCapability(name: CapabilityName): string {
    if (this.overrides.has(name)) this.overrides.delete(name);
    else this.overrides.add(name);
    this.runtime?.setCapabilities(this.capabilityMap());
    this.notify();
    return this.overrides.has(name)
      ? `Disabled capability: ${name}.`
      : `Enabled capability: ${name}.`;
  }

  status(): WorkflowStatus {
    const detected = detectCapabilities(this.args.getToolDefinitions());
    const capabilities: CapabilityStatus[] = (
      Object.keys(CAPABILITIES) as CapabilityName[]
    ).map((name) => {
      const tools = detected.get(name);
      const source = tools?.[0]?.name;
      return {
        name,
        description: CAPABILITIES[name].description,
        connected: tools !== undefined && tools.length > 0,
        disabled: this.overrides.has(name),
        source,
      };
    });
    const view = this.runtime?.view() ?? null;
    if (view === null || this.runtime?.isActive() !== true) {
      return {
        active: false,
        name: undefined,
        stepIndex: 0,
        total: 0,
        label: "",
        steps: [],
        capabilities,
      };
    }
    return {
      active: true,
      name: view.name,
      stepIndex: view.stepIndex,
      total: view.total,
      label: view.label,
      steps: view.steps.map(({ step, status }) => ({
        label: step.label,
        status,
        capability: step.capability,
      })),
      capabilities,
    };
  }
}
