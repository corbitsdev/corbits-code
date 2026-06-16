import { DefaultDirector } from "@intx/inference";
import type {
  ReactorDirector,
  ReactorInboundEvent,
  ReactorState,
  ReactorCapabilities,
  ReactorAction,
  ToolDefinition,
} from "@intx/types/runtime";
import type { DirectorPersistedState } from "../session/state.js";
import {
  type SessionMetadata,
  type TaskBoundary,
  createPruningCompactor,
} from "../session/compactor.js";
import type { WorkflowCoordinator } from "../workflows/coordinator.js";
import { type } from "arktype";

const PathArgSchema = type({ path: "string" });

const PlanStepSchema = type({
  file: "string",
  action: "string",
  reason: "string",
});

const PlanArgsSchema = type({
  "goal?": "string",
  steps: PlanStepSchema.array(),
});

export type PlanStep = typeof PlanStepSchema.infer;

export type Plan = {
  goal?: string;
  steps: PlanStep[];
};

export const submitPlanDefinition: ToolDefinition = {
  name: "submit_plan",
  description:
    "Call this on your first turn to declare a structured plan for the task. Include a goal statement and ordered steps — each step should be actionable enough that another engineer could execute it without further context.",
  inputSchema: {
    type: "object",
    properties: {
      goal: { type: "string", description: "One-sentence statement of what this plan accomplishes" },
      steps: {
        type: "array",
        description: "Ordered list of planned steps",
        items: {
          type: "object",
          properties: {
            file: { type: "string", description: "Primary file or path this step touches (empty string if not file-specific)" },
            action: { type: "string", description: "Concrete action to take — specific enough to execute without asking questions" },
            reason: { type: "string", description: "Why this step is needed" },
          },
          required: ["file", "action", "reason"],
        },
      },
    },
    required: ["steps"],
  },
};

export const askOperatorDefinition: ToolDefinition = {
  name: "ask_operator",
  description:
    "Pause execution and ask the operator a clarifying question. Execution resumes when the operator selects an option.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to ask the operator",
      },
      options: {
        type: "array",
        description: "List of options the operator can choose from",
        items: { type: "string" },
        minItems: 1,
      },
    },
    required: ["question", "options"],
  },
};

export const presentDefinition: ToolDefinition = {
  name: "present",
  description:
    "Render a rich UI for the user from a JSON view spec built from a fixed set of building blocks. " +
    "Use this to show structured data (lists, records, comparisons, status) instead of writing a Markdown table or pasting raw output. " +
    "The `view` is a node tree. Node types: " +
    "stack{children:[node],gap?:0|1} (vertical container); " +
    "heading{value,level?:1|2|3}; text{value,tone?,bold?,dim?}; divider; badge{label,tone?}; progress{value,max?,label?}; " +
    "list{items:[string],ordered?}; keyValue{pairs:[{label,value,tone?}]}; " +
    "table{columns:[{header,field,align?,colorRole?}],rows:[{<field>:string}]}; " +
    "card{title?,subtitle?,fields:[{label,value,tone?}],badges?:[{label,tone?}]}. " +
    "tone is one of default|muted|success|warning|danger|accent. colorRole may be a tone or \"status\"/\"priority\" to auto-color a cell by its value. " +
    "Keep it compact; the UI handles width and scrolling.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "object",
        description: "The root view node (typically a stack of building-block nodes).",
      },
    },
    required: ["view"],
  },
};

// Tools the agent cannot call while plan phase is active. The agent explores
// and designs in read-only mode; editing unlocks only after the plan is approved.
export const PLAN_PHASE_BLOCKED_TOOLS = new Set(["write_file", "edit_file"]);

export const planEnterDefinition: ToolDefinition = {
  name: "plan_enter",
  description:
    "Switch to plan mode before making any changes. In plan mode, write and edit " +
    "tools are disabled — you can only read, explore, and call submit_plan. Use this " +
    "when the task is non-trivial or you need to understand the codebase before acting. " +
    "Call submit_plan to present your plan for user approval; the full toolset unlocks " +
    "once the plan is approved.",
  inputSchema: { type: "object", properties: {} },
};

export const suggestWorkflowDefinition: ToolDefinition = {
  name: "suggest_workflow",
  description:
    "Suggest launching a named workflow when the user's request clearly maps to one. " +
    "Present the workflow and extracted context for operator approval before starting. " +
    "Only call this once per message, and only when no workflow is already active.",
  inputSchema: {
    type: "object",
    properties: {
      workflow: {
        type: "string",
        description: "Workflow name (e.g. triage-bug, build-feature, code-review)",
      },
      context: {
        type: "string",
        description:
          "Key context extracted from the user's message (bug description, feature request, etc.)",
      },
      reason: {
        type: "string",
        description: "One sentence explaining why this workflow fits the request",
      },
    },
    required: ["workflow", "reason"],
  },
};

export const advanceWorkflowDefinition: ToolDefinition = {
  name: "advance_workflow",
  description:
    "Call this when the current workflow step is finished to advance to the next step. " +
    "Include an optional note summarizing what the step accomplished.",
  inputSchema: {
    type: "object",
    properties: {
      note: {
        type: "string",
        description: "Optional summary of what this step accomplished",
      },
    },
  },
};

export const submitOutputDefinition: ToolDefinition = {
  name: "submit_output",
  description:
    "Call this when the task is fully complete (include summary) or to advance " +
    "a workflow step (include step id).",
  inputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Brief summary of the completed work",
      },
      step: {
        type: "string",
        description: "Workflow step ID to advance. When present this is a " +
          "step-advancement signal, not a terminal task submission.",
      },
    },
  },
};

export interface CodingDirector extends ReactorDirector {
  getTurnsUsed(): number;
  getState(): DirectorPersistedState;
  setState(state: DirectorPersistedState): void;
  getFilesReadAtTurn(): ReadonlyMap<string, number>;
  setWorkflowCoordinator(coordinator: WorkflowCoordinator | undefined): void;
  updateToolDefinitions(toolDefinitions: ToolDefinition[]): void;
}


function parsePlanArgs(args: unknown): { goal?: string; steps: PlanStep[] } | null {
  const result = PlanArgsSchema(args);
  return result instanceof type.errors ? null : result;
}

function isSuccessfulToolResult(result: { content: unknown; isError?: boolean }): boolean {
  if (result.isError === true) return false;
  return typeof result.content !== "string" || !result.content.startsWith("Error:");
}

function isOperatorDeclinedToolResult(result: { content: unknown; isError?: boolean }): boolean {
  return (
    result.isError === true &&
    typeof result.content === "string" &&
    result.content.includes("Blocked by permission policy: Operator declined:")
  );
}

function operatorDeclinedHasMessage(result: { content: unknown }): boolean {
  return typeof result.content === "string" && / — .+/.test(result.content);
}

class CodingDirectorImpl extends DefaultDirector implements CodingDirector {
  private submitCalled = false;
  private _turnsUsed = 0;
  private readonly callIdToName = new Map<string, string>();
  private readonly callIdToArgs = new Map<string, unknown>();
  private readonly filesReadAtTurn = new Map<string, number>();
  private idleCycles = 0;
  private planSubmitted = false;
  private plan: PlanStep[] = [];
  private readonly maxTurns: number | undefined;
  private readonly inactivityTimeoutMs: number | undefined;
  private readonly totalTimeoutMs: number | undefined;
  // Tracks whether this director has already emitted done() so that any
  // stray events delivered after termination do not produce a second done().
  private terminated = false;
  // advance_workflow / submit_output calls, tracked by id so tool.done can ask
  // the coordinator whether they advance the active workflow.
  private readonly workflowCalls = new Map<string, { name: string; args: unknown }>();
  private workflowCoordinator: WorkflowCoordinator | undefined;
  // Counts consecutive turns with no tool calls while a workflow is active.
  // After the threshold the director falls back to wait() so a stuck agent
  // does not spin forever.
  private workflowIdleTurns = 0;
  private readonly _systemPrompt: string;
  private _toolDefinitions: ToolDefinition[];

  constructor(
    systemPrompt: string,
    toolDefinitions: ToolDefinition[],
    initialState?: DirectorPersistedState,
    maxTurns?: number,
    inactivityTimeoutMs?: number,
    totalTimeoutMs?: number,
    workflowCoordinator?: WorkflowCoordinator,
  ) {
    super(systemPrompt, toolDefinitions, {});
    this._systemPrompt = systemPrompt;
    this._toolDefinitions = toolDefinitions;
    this.maxTurns = maxTurns;
    this.inactivityTimeoutMs = inactivityTimeoutMs;
    this.totalTimeoutMs = totalTimeoutMs;
    this.workflowCoordinator = workflowCoordinator;
    if (initialState !== undefined) {
      this.setState(initialState);
    }
  }

  // Attach or detach the workflow coordinator (set after construction once
  // a workflow is started via slash command or auto-invoke).
  setWorkflowCoordinator(coordinator: WorkflowCoordinator | undefined): void {
    this.workflowCoordinator = coordinator;
  }

  // Replace the live tool set advertised to the model. MCP servers connect
  // after the session is already running; any inference before they finish
  // must learn about their tools on the next turn.
  updateToolDefinitions(toolDefinitions: ToolDefinition[]): void {
    this._toolDefinitions = toolDefinitions;
  }

  private withCurrentTools(
    result: ReactorAction | ReactorAction[],
  ): ReactorAction | ReactorAction[] {
    // When a workflow is active, advertise the advance_workflow tool and append
    // the current step's directive to the system prompt so the model sees the
    // step instruction at the start of each turn.
    const active = this.workflowCoordinator?.isActive() === true;
    const tools = active && !this._toolDefinitions.some((t) => t.name === advanceWorkflowDefinition.name)
      ? [...this._toolDefinitions, advanceWorkflowDefinition]
      : this._toolDefinitions;
    const directive = active ? this.workflowCoordinator?.directive() ?? null : null;
    const rewrite = (action: ReactorAction): ReactorAction => {
      if (action.type !== "infer") return action;
      const options = { ...action.options, tools };
      if (this.inactivityTimeoutMs !== undefined) options.inactivityTimeoutMs = this.inactivityTimeoutMs;
      if (this.totalTimeoutMs !== undefined) options.totalTimeoutMs = this.totalTimeoutMs;
      if (directive !== null) {
        const base = action.options?.systemPrompt ?? this._systemPrompt;
        options.systemPrompt = `${base}\n\n${directive}`;
      }
      return { type: "infer", options };
    };
    return Array.isArray(result) ? result.map(rewrite) : rewrite(result);
  }

  override async decide(
    event: ReactorInboundEvent,
    state: ReactorState,
    capabilities: ReactorCapabilities,
  ): Promise<ReactorAction | ReactorAction[]> {
    const base = await this.decideInner(event, state, capabilities);
    return this.withCurrentTools(base);
  }

  private async decideInner(
    event: ReactorInboundEvent,
    state: ReactorState,
    capabilities: ReactorCapabilities,
  ): Promise<ReactorAction | ReactorAction[]> {
    if (this.terminated) {
      // The loop is over; swallow stray events rather than double-firing done().
      return [];
    }

    if (event.type === "inference.done") {
      this._turnsUsed++;

      if (this.maxTurns !== undefined && this._turnsUsed >= this.maxTurns) {
        this.terminated = true;
        return [
          capabilities.checkpoint("max-turns-reached"),
          capabilities.reply(`Agent stopped: reached the configured limit of ${this.maxTurns} turns.`),
          capabilities.done(),
        ];
      }

      const hasToolCalls = event.turn.content.some(
        (b) => b.type === "tool_call",
      );
      if (hasToolCalls) {
        this.idleCycles = 0;
      } else {
        this.idleCycles++;
      }

      if (this.workflowCoordinator?.isActive()) {
        if (hasToolCalls) {
          this.workflowIdleTurns = 0;
        } else {
          this.workflowIdleTurns++;
        }
      }
      for (const block of event.turn.content) {
        if (block.type === "tool_call") {
          this.callIdToName.set(block.id, block.name);
          this.callIdToArgs.set(block.id, block.arguments);
          if (block.name === "submit_plan") {
            const planArgs = parsePlanArgs(block.arguments);
            if (planArgs !== null) {
              this.plan = planArgs.steps;
              this.planSubmitted = true;
            }
          }
          if (block.name === "advance_workflow" || block.name === "submit_output") {
            this.workflowCalls.set(block.id, { name: block.name, args: block.arguments });
          }
        }
      }

      if (this.submitCalled) {
        if (!hasToolCalls) {
          // submit_output is the clean termination signal. Once it has succeeded
          // and the model produces a turn with no further tool calls, end the
          // run — emitting done() and latching terminated so a stray later event
          // cannot reopen the loop (without this, the run only stops at the
          // maxTurns backstop).
          this.terminated = true;
          return [
            capabilities.checkpoint("submit-accepted"),
            capabilities.reply("Task completed."),
            capabilities.done(),
          ];
        }
      }

      if (this.idleCycles >= 3 && !this.workflowCoordinator?.isActive()) {
        this.terminated = true;
        return [
          capabilities.checkpoint("idle-abort"),
          capabilities.reply("Agent stalled: no tool calls for 3 turns."),
          capabilities.done(),
        ];
      }

    }

    if (event.type === "tool.done") {
      // A completed advance_workflow or step-tagged submit_output moves the
      // workflow runtime to its next step. Handle this before any other
      // tool.done processing so the coordinator advances before the downstream
      // submit_output termination check.
      if (this.workflowCalls.has(event.result.callId)) {
        const call = this.workflowCalls.get(event.result.callId);
        this.workflowCalls.delete(event.result.callId);
        const advanced = this.workflowCoordinator?.handleToolDone(call?.name, call?.args, event.result.isError === true);
        if (advanced) this.workflowIdleTurns = 0;
      }

      if (isOperatorDeclinedToolResult(event.result)) {
        // Headless contract: the operator said no, so end the run cleanly and
        // record why in the transcript. (The interactive chat director instead
        // keeps the reactor alive — see ChatDirectorImpl — because done() there
        // would kill further sends.) Mark terminal so a stray later event cannot
        // re-enter decide() and emit a second done().
        this.terminated = true;
        return [
          capabilities.checkpoint("operator-declined"),
          capabilities.reply("Tool call rejected by operator."),
          capabilities.done(),
        ];
      }
      const name = this.callIdToName.get(event.result.callId);
      // A step-tagged submit_output ({ step }) is a workflow step-advance signal,
      // not a terminal submit. Do not latch termination on it, so the two
      // meanings of submit_output cannot collide when a workflow is driving.
      const submitArgs = this.callIdToArgs.get(event.result.callId);
      const isStepTagged = !(type({ step: "string" })(submitArgs) instanceof type.errors);
      if (name === "submit_output" && isSuccessfulToolResult(event.result) && !isStepTagged) {
        this.submitCalled = true;
        if (!this.planSubmitted && this._turnsUsed - 1 > 3) {
          const base = await super.decide(event, state, capabilities);
          const baseActions = Array.isArray(base) ? base : [base];
          return [...baseActions, capabilities.reply("Warning: task completed without a plan. Consider calling submit_plan on turn 1 for multi-step tasks.")];
        }
      }
      if (name === "read_file" && !event.result.isError) {
        const args = this.callIdToArgs.get(event.result.callId);
        const parsed = type({ path: "string" })(args);
        const path = parsed instanceof type.errors ? "" : parsed.path;
        if (path.length > 0) {
          this.filesReadAtTurn.set(path, this._turnsUsed);
        }
      }
    }

    const base = await super.decide(event, state, capabilities);

    // When a workflow is active and not at a gate, substitute terminal
    // actions (wait / reply) with a fresh infer() so the agent keeps
    // executing autonomously. After 3 consecutive tool-call-free turns
    // the agent is stuck; fall back to wait() so the user can intervene.
    const coordinator = this.workflowCoordinator;
    if (coordinator?.isActive() && !coordinator.currentStepIsGate()) {
      const actions = Array.isArray(base) ? base : [base];
      const hasTerminal = actions.some((a) => a.type === "wait" || a.type === "reply");
      if (hasTerminal) {
        if (this.workflowIdleTurns >= 3) {
          // Headless mode: wait() is the only valid terminal — do not pair with reply().
          return [capabilities.wait()];
        }
        const nudge = "\n\nYou have not yet called advance_workflow. " +
          "If this step is complete, call advance_workflow now. " +
          "Otherwise continue working with tools.";
        // Only add the nudge here; withCurrentTools() (applied in the outer
        // decide()) injects the directive and the advance_workflow tool
        // definition. Putting the directive here too would double it.
        const systemPrompt = `${this._systemPrompt}${nudge}`;
        const passThrough = actions.filter(
          (a): a is Exclude<ReactorAction, { type: "wait" } | { type: "reply" }> =>
            a.type !== "wait" && a.type !== "reply",
        );
        return [...passThrough, capabilities.infer({ systemPrompt })];
      }
    }

    return base;
  }

  getTurnsUsed(): number {
    return this._turnsUsed;
  }

  getState(): DirectorPersistedState {
    const callIdToName: Record<string, string> = {};
    for (const [k, v] of this.callIdToName) {
      callIdToName[k] = v;
    }
    return {
      turnsUsed: this._turnsUsed,
      submitCalled: this.submitCalled,
      callIdToName,
      idleCycles: this.idleCycles,
      planSubmitted: this.planSubmitted,
      plan: this.plan,
      terminated: this.terminated,
      filesRead: [...this.filesReadAtTurn.entries()].map(([path, turn]) => ({ path, turn })),
    };
  }

  setState(state: DirectorPersistedState): void {
    this._turnsUsed = state.turnsUsed;
    this.submitCalled = state.submitCalled;
    this.callIdToName.clear();
    for (const [k, v] of Object.entries(state.callIdToName)) {
      this.callIdToName.set(k, v);
    }
    this.idleCycles = state.idleCycles ?? 0;
    this.planSubmitted = state.planSubmitted ?? false;
    this.plan = state.plan ?? [];
    // Restore the terminal latch so a run resumed from a terminal checkpoint
    // does not re-enter the loop with the guard reset to false.
    this.terminated = state.terminated ?? false;
    this.filesReadAtTurn.clear();
    for (const { path, turn } of state.filesRead ?? []) {
      this.filesReadAtTurn.set(path, turn);
    }
  }

  getFilesReadAtTurn(): ReadonlyMap<string, number> {
    return this.filesReadAtTurn;
  }
}

export function createCodingDirector(
  systemPrompt: string,
  toolDefinitions: ToolDefinition[],
  initialState?: DirectorPersistedState,
  maxTurns?: number,
  inactivityTimeoutMs?: number,
  totalTimeoutMs?: number,
  workflowCoordinator?: WorkflowCoordinator,
): CodingDirector {
  return new CodingDirectorImpl(systemPrompt, toolDefinitions, initialState, maxTurns, inactivityTimeoutMs, totalTimeoutMs, workflowCoordinator);
}

export type ApprovalGate = (plan: PlanStep[]) => Promise<boolean>;

const CODE_FILE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cc|cpp|h|hpp|rb|php|cs|swift|kt|kts|scala)$/i;

function isCodeFile(path: string): boolean {
  return CODE_FILE_EXT.test(path);
}

class ChatDirectorImpl extends DefaultDirector {
  private readonly submitPlanArgs = new Map<string, unknown>();
  // advance_workflow / submit_output calls, tracked by id so tool.done can ask
  // the coordinator whether they advance the active workflow.
  private readonly workflowCalls = new Map<string, { name: string; args: unknown }>();
  // read_file/edit_file calls targeting a code file; on success they auto-load
  // the language server so LSP is enabled "at that point in time".
  private readonly lspTriggerCalls = new Set<string>();
  private readonly askOperatorCalls = new Set<string>();
  private readonly onActivateTools: ((names: string[]) => void) | undefined;
  private readonly approvalGate: ApprovalGate;
  private readonly taskClassifier:
    | ((message: string, metadata: SessionMetadata) => Promise<TaskBoundary>)
    | undefined;
  private readonly _systemPrompt: string;
  private _toolDefinitions: ToolDefinition[];
  private inactivityTimeoutMs: number | undefined;
  private totalTimeoutMs: number | undefined;
  private workflowCoordinator: WorkflowCoordinator | undefined;
  // Counts consecutive turns with no tool calls while a workflow is active.
  // After the threshold the director falls back to wait() so a stuck agent
  // does not spin forever.
  private workflowIdleTurns = 0;
  private lastInferenceTurnHadContent = false;
  // Set when ask_operator completes successfully. The agent's next reply is a
  // legitimate request for free-form operator input, not workflow idling — let
  // it through instead of suppressing it with a forced re-inference.
  private operatorJustResponded = false;
  planPhaseActive = false;
  // Fired each time plan phase is entered or exited so the TUI can update its
  // status display without polling.
  private readonly onPlanPhaseChange: ((active: boolean) => void) | undefined;
  private turnCount = 0;
  private currentTaskLabel: string | undefined;
  private lastTaskSummary: string | undefined;
  private startedAt = Date.now();
  // Inline compaction: built when token usage crosses the threshold and injected
  // into the next infer's system prompt so older turns don't bloat the context.
  private compactionEnvelope: string | undefined;
  // Cumulative input tokens at the last inline compaction. Prevents re-compacting
  // on every turn after the threshold is first crossed.
  private lastCompactedAtTokens = 0;

  constructor(
    systemPrompt: string,
    toolDefinitions: ToolDefinition[],
    approvalGate: ApprovalGate,
    taskClassifier?: (message: string, metadata: SessionMetadata) => Promise<TaskBoundary>,
    onActivateTools?: (names: string[]) => void,
    inactivityTimeoutMs?: number,
    totalTimeoutMs?: number,
    workflowCoordinator?: WorkflowCoordinator,
    onPlanPhaseChange?: (active: boolean) => void,
  ) {
    super(systemPrompt, toolDefinitions, {});
    this._systemPrompt = systemPrompt;
    this._toolDefinitions = toolDefinitions;
    this.inactivityTimeoutMs = inactivityTimeoutMs;
    this.totalTimeoutMs = totalTimeoutMs;
    this.approvalGate = approvalGate;
    this.taskClassifier = taskClassifier;
    this.onActivateTools = onActivateTools;
    this.workflowCoordinator = workflowCoordinator;
    this.onPlanPhaseChange = onPlanPhaseChange;
  }

  // The TUI builds the coordinator only once a workflow is started (via slash
  // command or auto-invoke), so it is wired in after construction.
  setWorkflowCoordinator(coordinator: WorkflowCoordinator | undefined): void {
    this.workflowCoordinator = coordinator;
  }

  // Enter plan phase: strip write/edit tools from infer actions until the user
  // approves a submit_plan. Called by the /plan slash command and the plan_enter tool.
  enterPlanPhase(): void {
    if (this.planPhaseActive) return;
    this.planPhaseActive = true;
    this.onPlanPhaseChange?.(true);
  }

  exitPlanPhase(): void {
    if (!this.planPhaseActive) return;
    this.planPhaseActive = false;
    this.onPlanPhaseChange?.(false);
  }

  // Replace the live tool set the model is advertised. MCP servers connect after
  // the session is already running, so any inference issued before they finish
  // must learn about their tools on the next turn. The base director advertises
  // its own (construction-time) tool list, so we override the tools on every
  // infer action this director emits with the current set.
  updateToolDefinitions(toolDefinitions: ToolDefinition[]): void {
    this._toolDefinitions = toolDefinitions;
  }

  private withCurrentTools(
    result: ReactorAction | ReactorAction[],
  ): ReactorAction | ReactorAction[] {
    // When a workflow is active, advertise the advance_workflow tool and append
    // the current step's directive to the system prompt so the model sees the
    // step instruction at the start of each turn.
    const active = this.workflowCoordinator?.isActive() === true;
    let tools = active && !this._toolDefinitions.some((t) => t.name === advanceWorkflowDefinition.name)
      ? [...this._toolDefinitions, advanceWorkflowDefinition]
      : this._toolDefinitions;

    // During plan phase, strip tools that mutate the working tree so the agent
    // is forced to explore and design before making changes.
    if (this.planPhaseActive) {
      tools = tools.filter((t) => !PLAN_PHASE_BLOCKED_TOOLS.has(t.name));
    }

    const directive = active ? this.workflowCoordinator?.directive() ?? null : null;
    const planDirective = this.planPhaseActive
      ? "\n\n[PLAN MODE ACTIVE] You are in read-only planning mode. " +
        "write_file and edit_file are disabled. Explore the codebase, then call " +
        "submit_plan with a structured plan. The full toolset unlocks once your plan is approved. " +
        "Do not narrate or apologize for the disabled tools."
      : null;

    const compactionNote = this.compactionEnvelope ?? null;

    const rewrite = (action: ReactorAction): ReactorAction => {
      if (action.type !== "infer") return action;
      const options = { ...action.options, tools };
      if (this.inactivityTimeoutMs !== undefined) options.inactivityTimeoutMs = this.inactivityTimeoutMs;
      if (this.totalTimeoutMs !== undefined) options.totalTimeoutMs = this.totalTimeoutMs;
      const base = action.options?.systemPrompt ?? this._systemPrompt;
      let prompt = base;
      if (compactionNote !== null) prompt = `${prompt}\n\n${compactionNote}`;
      if (directive !== null) prompt = `${prompt}\n\n${directive}`;
      if (planDirective !== null) prompt = `${prompt}${planDirective}`;
      if (prompt !== base) options.systemPrompt = prompt;
      return { type: "infer", options };
    };
    return Array.isArray(result) ? result.map(rewrite) : rewrite(result);
  }

  override async decide(
    event: ReactorInboundEvent,
    state: ReactorState,
    capabilities: ReactorCapabilities,
  ): Promise<ReactorAction | ReactorAction[]> {
    return this.withCurrentTools(await this.decideInner(event, state, capabilities));
  }

  private async decideInner(
    event: ReactorInboundEvent,
    state: ReactorState,
    capabilities: ReactorCapabilities,
  ): Promise<ReactorAction | ReactorAction[]> {
    // Intercept message.received for task boundary detection.
    // When a new task is detected, build a context envelope with a compacted
    // summary of prior work and pass it as part of the system prompt. This
    // avoids pairing compact + infer (which the action validator forbids)
    // while still curating what the model sees.
    if (event.type === "message.received" && this.taskClassifier !== undefined) {
      const message = event.message;
      const content = typeof message.content === "string" ? message.content : "";
      const metadata: SessionMetadata = {
        turnCount: this.turnCount,
        currentTaskLabel: this.currentTaskLabel,
        lastTaskSummary: this.lastTaskSummary,
        minutesElapsed: Math.floor((Date.now() - this.startedAt) / 60000),
        toolCallCount: 0,
      };

      try {
        const boundary = await this.taskClassifier(content, metadata);
        if (boundary.kind === "new_task") {
          this.currentTaskLabel = undefined;

          // Build a compacted context envelope. For v1 this uses a simple
          // deterministic summary; future iterations can add LLM summarization.
          const envelope = this.lastTaskSummary !== undefined
            ? `\n--- Compacted prior context ---\n${this.lastTaskSummary}\n---` +
              `\n\nNew task starting now. Prior context summarized above.\n`
            : "\n--- Context cleared for new task ---\n";

          return [
            capabilities.checkpoint(`new-task: ${boundary.reason}`),
            capabilities.infer({
              systemPrompt: this._systemPrompt + envelope,
              tools: this._toolDefinitions,
            }),
          ];
        }
      } catch {
        // Classifier failure should not break the session. Fall through to infer.
      }
    }

    if (event.type === "inference.done") {
      this.turnCount++;
      const hasToolCalls = event.turn.content.some((b) => b.type === "tool_call");
      const hasText = event.turn.content.some(
        (b) => b.type === "text" && typeof b.text === "string" && b.text.length > 0,
      );
      this.lastInferenceTurnHadContent = hasToolCalls || hasText;
      if (this.workflowCoordinator?.isActive()) {
        if (hasToolCalls) {
          this.workflowIdleTurns = 0;
        } else {
          this.workflowIdleTurns++;
        }
      }
      for (const block of event.turn.content) {
        if (block.type !== "tool_call") continue;
        if (block.name === "submit_plan") {
          this.submitPlanArgs.set(block.id, block.arguments);
        } else if (block.name === "read_file" || block.name === "edit_file") {
          const pathResult = PathArgSchema(block.arguments);
          const path = pathResult instanceof type.errors ? "" : pathResult.path;
          if (isCodeFile(path)) this.lspTriggerCalls.add(block.id);
        }
        if (block.name === "advance_workflow" || block.name === "submit_output") {
          this.workflowCalls.set(block.id, { name: block.name, args: block.arguments });
        }
        if (block.name === "ask_operator") {
          this.askOperatorCalls.add(block.id);
        }
      }
    }

    // A completed advance_workflow or step-tagged submit_output moves the
    // workflow runtime to its next step.
    if (event.type === "tool.done" && this.workflowCalls.has(event.result.callId)) {
      const call = this.workflowCalls.get(event.result.callId);
      this.workflowCalls.delete(event.result.callId);
      const advanced = this.workflowCoordinator?.handleToolDone(call?.name, call?.args, event.result.isError === true);
      if (advanced) this.workflowIdleTurns = 0;
    }

    // When ask_operator completes, the agent's next turn may legitimately reply
    // asking for free-form input rather than making tool calls. Flag this so the
    // terminal-substitution logic below lets that reply pass through.
    if (event.type === "tool.done" && this.askOperatorCalls.has(event.result.callId)) {
      this.askOperatorCalls.delete(event.result.callId);
      if (!event.result.isError) {
        this.operatorJustResponded = true;
      }
    }

    // Reading or editing a code file auto-loads the language server for the rest
    // of the session, so the model gets LSP without having to discover it.
    if (event.type === "tool.done" && this.lspTriggerCalls.has(event.result.callId)) {
      this.lspTriggerCalls.delete(event.result.callId);
      if (!event.result.isError) this.onActivateTools?.(["lsp"]);
    }

    if (event.type === "tool.done" && this.submitPlanArgs.has(event.result.callId)) {
      const args = this.submitPlanArgs.get(event.result.callId);
      this.submitPlanArgs.delete(event.result.callId);
      if (!event.result.isError) {
        const plan = parsePlanArgs(args)?.steps ?? [];
        const approved = await this.approvalGate(plan);
        if (!approved) {
          return capabilities.done();
        }
        // Plan approved — exit plan phase and unlock the full toolset.
        if (this.planPhaseActive) {
          this.planPhaseActive = false;
          this.onPlanPhaseChange?.(false);
        }
      }
    }

    if (event.type === "tool.done" && isOperatorDeclinedToolResult(event.result)) {
      if (operatorDeclinedHasMessage(event.result)) {
        // Operator provided a reason — let the model see the rejection and continue.
        return super.decide(event, state, capabilities);
      }
      // Reject without message: end this turn but keep the reactor alive so
      // the user can send another message. reply() resolves the send cycle;
      // done() would permanently kill the reactor, breaking further sends.
      return [
        capabilities.checkpoint("operator-declined"),
        capabilities.reply("Tool call rejected by operator."),
      ];
    }

    // Inline compaction: when cumulative input tokens exceed the threshold and we
    // haven't compacted recently, summarize older turns into a system prompt envelope.
    // This keeps individual requests from growing unboundedly without requiring the
    // reactor's compact action (which stalls inference until a new user message).
    const COMPACT_THRESHOLD_TOKENS = 80_000;
    const COMPACT_COOLDOWN_TOKENS = 40_000;
    const cumulativeInputTokens = state.tokenUsage?.input ?? 0;
    const tokensSinceLastCompact = cumulativeInputTokens - this.lastCompactedAtTokens;
    if (
      event.type === "inference.done" &&
      cumulativeInputTokens > COMPACT_THRESHOLD_TOKENS &&
      tokensSinceLastCompact > COMPACT_COOLDOWN_TOKENS &&
      state.turns.length > 6
    ) {
      const compactor = createPruningCompactor({ keepRecentTurns: 6, summaryMaxChars: 2500 });
      try {
        const result = await compactor.apply(state.turns, {
          state,
          trigger: "director:token-threshold",
        });
        const summaryTurn = result.output[0];
        const summaryText =
          summaryTurn !== undefined &&
          summaryTurn.role === "system" &&
          summaryTurn.content[0] !== undefined &&
          summaryTurn.content[0].type === "text"
            ? summaryTurn.content[0].text
            : undefined;
        if (summaryText !== undefined) {
          this.compactionEnvelope =
            `--- Context compacted (${Math.round(state.tokenUsage.input / 1000)}k tokens) ---\n` +
            summaryText +
            `\n--- End compacted context ---`;
          this.lastCompactedAtTokens = state.tokenUsage.input;
        }
      } catch {
        // Compaction failure should not break the session.
      }
    }

    const base = await super.decide(event, state, capabilities);

    // When a workflow is running and not at a gate step, substitute any terminal
    // action (wait or reply) with a fresh infer() so the agent keeps executing
    // autonomously. In conversational mode, a text-only turn produces reply() not
    // wait(), so we must trigger on both. After 3 consecutive tool-call-free turns
    // the agent is stuck; fall back to wait() and show a message so the user can
    // intervene.
    const coordinator = this.workflowCoordinator;
    if (coordinator?.isActive() && !coordinator.currentStepIsGate()) {
      const actions = Array.isArray(base) ? base : [base];
      const hasTerminal = actions.some((a) => a.type === "wait" || a.type === "reply");
      if (hasTerminal && this.lastInferenceTurnHadContent) {
        // ask_operator just completed: the agent is legitimately waiting for
        // free-form operator input, not idling. Let the reply through.
        if (this.operatorJustResponded) {
          this.operatorJustResponded = false;
          return base;
        }
        if (this.workflowIdleTurns >= 3) {
          // reply() in chat mode keeps the reactor alive — do not pair with wait().
          return [
            capabilities.reply(
              "The workflow appears stuck on this step. Send a message to continue or advance manually.",
            ),
          ];
        }
        // Strip both reply() and wait() — the reactor exits early after reply()
        // and never processes subsequent actions, so infer() would be dropped.
        // Text content is already rendered via inference.text.delta; we don't
        // need reply() for display. Keep checkpoint() and other non-terminal actions.
        const nudge = "\n\nYou have not yet called advance_workflow. " +
          "If this step is complete, call advance_workflow now. " +
          "Otherwise continue working with tools.";
        // Only add the nudge here; withCurrentTools() (applied in the outer
        // decide()) injects the directive and the advance_workflow tool
        // definition. Putting the directive here too would double it.
        const systemPrompt = `${this._systemPrompt}${nudge}`;
        const passThrough = actions.filter(
          (a): a is Exclude<ReactorAction, { type: "wait" } | { type: "reply" }> =>
            a.type !== "wait" && a.type !== "reply",
        );
        return [...passThrough, capabilities.infer({ systemPrompt })];
      }
    }

    return base;
  }

  /** Called by the TUI to signal a task boundary (/clear or /new command). */
  signalNewTask(summary?: string): void {
    this.currentTaskLabel = undefined;
    this.lastTaskSummary = summary;
  }
}

export function createChatDirector(
  systemPrompt: string,
  toolDefinitions: ToolDefinition[],
  approvalGate?: ApprovalGate,
  taskClassifier?: (message: string, metadata: SessionMetadata) => Promise<TaskBoundary>,
  onActivateTools?: (names: string[]) => void,
  workflowCoordinator?: WorkflowCoordinator,
  onPlanPhaseChange?: (active: boolean) => void,
  inactivityTimeoutMs?: number,
  totalTimeoutMs?: number,
): ChatDirectorWithClear {
  const gate = approvalGate ?? (async () => true);
  return new ChatDirectorImpl(
    systemPrompt,
    toolDefinitions,
    gate,
    taskClassifier,
    onActivateTools,
    inactivityTimeoutMs,
    totalTimeoutMs,
    workflowCoordinator,
    onPlanPhaseChange,
  );
}

export interface ChatDirectorWithClear extends ReactorDirector {
  readonly planPhaseActive: boolean;
  signalNewTask(summary?: string): void;
  updateToolDefinitions(toolDefinitions: ToolDefinition[]): void;
  setWorkflowCoordinator(coordinator: WorkflowCoordinator | undefined): void;
  enterPlanPhase(): void;
  exitPlanPhase(): void;
}
