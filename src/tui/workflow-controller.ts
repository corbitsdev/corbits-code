import type { EventEmitter } from "node:events";
import { join } from "node:path";
import type { ToolDefinition } from "@intx/types/runtime";

import { sessionDir } from "../session/index.js";
import { CAPABILITIES, detectCapabilities, type CapabilityMap } from "../workflows/capabilities.js";
import { WorkflowCoordinator } from "../workflows/coordinator.js";
import { findWorkflow, WORKFLOWS } from "../workflows/index.js";
import { WorkflowRuntime } from "../workflows/runtime.js";
import {
  loadWorkflowState,
  saveWorkflowState,
  warnWorkflowPersistenceFailure,
} from "../workflows/state.js";
import type {
  CapabilityName,
  StepStatus,
  Workflow,
  WorkflowCompleteResult,
} from "../workflows/types.js";
import type { WorkflowEvent } from "../workflows/runtime.js";

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

export interface WorkflowControllerState {
  current: WorkflowStatus;
  history: WorkflowStatus[];
}

type SetCoordinator = (coordinator: WorkflowCoordinator | undefined) => void;

export interface WorkflowControllerArgs {
  cwd: string;
  emitter: EventEmitter;
  getSessionId: () => string;
  getToolDefinitions: () => ToolDefinition[];
  // The live chat director; the workflow coordinator is attached to it when a
  // workflow starts. Returns undefined before the director is built.
  getDirector: () => { setWorkflowCoordinator: SetCoordinator } | undefined;
  // Overrides the state-tree home (defaults to the real user home). Tests
  // pass a sandboxed dir here so persist()/resume() never touch ~/.corbits.
  home?: string;
}

// Owns the workflow lifecycle for the TUI: starting, capability overrides,
// resume, and publishing status to the UI via the "workflow" emitter event.
// Framework-agnostic so it can be unit-tested without React.
export class WorkflowController {
  private runtime: WorkflowRuntime | undefined;
  private coordinator: WorkflowCoordinator | undefined;
  private overrides = new Set<CapabilityName>();
  private pendingReplace: string | undefined;
  private completedWorkflows: WorkflowStatus[] = [];
  // Last status snapshot seen while the workflow was active. Used to populate
  // history on workflow-complete, where isActive() is already false.
  private lastActiveStatus: WorkflowStatus | undefined;

  constructor(private readonly args: WorkflowControllerArgs) {}

  // Re-attach the active coordinator to a freshly rebuilt director (the TUI
  // rebuilds the agent when MCP servers connect). Safe to call with no active
  // workflow — it just clears any stale coordinator.
  reattach(): void {
    this.args.getDirector()?.setWorkflowCoordinator(this.coordinator);
  }

  // Drop the active workflow and history (e.g. on /clear, which starts a fresh session).
  reset(): void {
    this.runtime = undefined;
    this.coordinator = undefined;
    this.pendingReplace = undefined;
    this.completedWorkflows = [];
    this.lastActiveStatus = undefined;
    this.args.getDirector()?.setWorkflowCoordinator(undefined);
    this.publish();
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

  private publish(): void {
    const current = this.status();
    if (current.active) this.lastActiveStatus = current;
    this.args.emitter.emit("workflow", { current, history: this.completedWorkflows });
  }

  private persist(): void {
    const runtime = this.runtime;
    if (runtime === undefined) return;
    const sessionId = this.args.getSessionId();
    void saveWorkflowState(this.args.cwd, sessionId, runtime.state(), this.args.home).catch(
      (err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        warnWorkflowPersistenceFailure(
          join(sessionDir(this.args.cwd, sessionId, this.args.home), "workflow.json"),
          reason,
        );
      },
    );
  }

  private attachRuntime(workflow: Workflow, restore?: boolean): WorkflowRuntime {
    const runtime = new WorkflowRuntime(this.capabilityMap());
    const coordinator = new WorkflowCoordinator(
      runtime,
      () => {
        this.persist();
        this.publish();
      },
      workflow.stepThrough === true,
    );
    this.listen(runtime);
    this.runtime = runtime;
    this.coordinator = coordinator;
    this.args.getDirector()?.setWorkflowCoordinator(coordinator);
    if (restore !== true) {
      runtime.start(workflow);
      this.persist();
      this.publish();
    }
    return runtime;
  }

  // Shared by start and resume so a restored run records history the same way
  // a fresh run does.
  private listen(runtime: WorkflowRuntime): void {
    runtime.on((event: WorkflowEvent) => {
      if (event.type === "workflow-complete") {
        // status() returns an empty shell here because runtime.done is already
        // true when the event fires. Use the last snapshot captured while the
        // workflow was still active.
        const snapshot = this.lastActiveStatus;
        if (snapshot !== undefined) {
          this.completedWorkflows.push({ ...snapshot, active: false, completedAt: Date.now() });
        }
      }
      this.persist();
      this.publish();
    });
  }

  private attach(workflow: Workflow): void {
    this.attachRuntime(workflow);
  }

  // Start a workflow by name. If one is already active, the first call asks for
  // confirmation and a second call with the same name replaces it.
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
    this.attach(workflow);
    return `Started ${name} workflow.`;
  }

  // Restore a persisted workflow for the current session, if any.
  async resume(): Promise<void> {
    const state = await loadWorkflowState(this.args.cwd, this.args.getSessionId(), this.args.home);
    if (state === null || state.completed || state.stack.length === 0) return;
    const rootName = state.stack[0]?.workflow;
    const workflow = rootName !== undefined ? findWorkflow(rootName) : undefined;
    if (workflow === undefined) return;
    const runtime = this.attachRuntime(workflow, true);
    runtime.restore(state);
    this.publish();
  }

  // Toggle a capability off/on for this run. Affects not-yet-reached steps of an
  // active workflow and the displayed status.
  toggleCapability(name: CapabilityName): string {
    if (this.overrides.has(name)) this.overrides.delete(name);
    else this.overrides.add(name);
    this.runtime?.setCapabilities(this.capabilityMap());
    this.publish();
    return this.overrides.has(name)
      ? `Disabled capability: ${name}.`
      : `Enabled capability: ${name}.`;
  }

  status(): WorkflowStatus {
    const detected = detectCapabilities(this.args.getToolDefinitions());
    const capabilities: CapabilityStatus[] = (Object.keys(CAPABILITIES) as CapabilityName[]).map(
      (name) => {
        const tools = detected.get(name);
        const source = tools?.[0]?.name;
        return {
          name,
          description: CAPABILITIES[name].description,
          connected: tools !== undefined && tools.length > 0,
          disabled: this.overrides.has(name),
          source,
        };
      },
    );
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
