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
} from "../session/compactor.js";
import type { WorkflowCoordinator } from "../workflows/coordinator.js";
import { compactionThresholdFor } from "../provider/context-window.js";
import { createCompactionGovernor, type CompactionGovernor } from "./compaction.js";
import { type } from "arktype";
import { applyManageTasks, parseManageTasksArgs, type Task } from "./tasks.js";
import { createIntercodeRetryPolicy } from "./retry-policy.js";

const RETRY_POLICY = createIntercodeRetryPolicy();

const PathArgSchema = type({ path: "string" });

export const askOperatorDefinition: ToolDefinition = {
  name: "ask_operator",
  description:
    "Pause execution and ask the operator a clarifying question. Execution resumes when the operator selects an option. " +
    "If the question is really asking permission to run one specific shell command, pass that exact command as `command` " +
    "instead of just describing it in the option text — approval here then covers the matching run_shell call too, so the " +
    "operator is not asked to approve the same action twice.",
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
      command: {
        type: "string",
        description:
          "The exact shell command this question is asking permission to run, verbatim, if applicable. " +
          "Approving an option here pre-authorizes the run_shell call for this exact command.",
      },
    },
    required: ["question", "options"],
  },
};

export const presentDefinition: ToolDefinition = {
  name: "present",
  description:
    "Render structured output for the user via a dynamic layout tree. " +
    "Use this (instead of markdown tables or raw dumps) when you want aligned columns, grouped records, status, or other composed blocks. " +
    "The `view` is a single root node tree built from generic layout primitives only — no fixed widget catalog. " +
    "Primitives: text{text, tone?, bold?, dim?}; " +
    "stack{children:[node], gap?:0|1}; row{children:[node], gap?:0|1}; " +
    "box{border?, padding?, children:[node]}; divider; " +
    "grid{columns?:[{align?}], rows: [ [cellNode, ...], ... ] } for aligned columns (cells are usually text nodes). " +
    "tone is one of default|muted|success|warning|danger|accent. " +
    "Keep it compact; the UI handles width and scrolling. Compose freely rather than targeting named shapes. " +
    'Example: {"view":{"type":"stack","children":[{"type":"text","text":"Build","bold":true},{"type":"row","gap":1,"children":[{"type":"text","text":"status:"},{"type":"text","text":"ok","tone":"success"}]}]}}',
  inputSchema: {
    type: "object",
    properties: {
      view: { $ref: "#/$defs/ViewNode" },
    },
    required: ["view"],
    $defs: {
      ViewNode: {
        oneOf: [
          { $ref: "#/$defs/Text" },
          { $ref: "#/$defs/Stack" },
          { $ref: "#/$defs/Row" },
          { $ref: "#/$defs/Box" },
          { $ref: "#/$defs/Divider" },
          { $ref: "#/$defs/Grid" },
        ],
      },
      Text: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["text"] },
          text: { type: "string" },
          tone: { type: "string", enum: ["default", "muted", "success", "warning", "danger", "accent"] },
          bold: { type: "boolean" },
          dim: { type: "boolean" },
        },
        required: ["type", "text"],
        additionalProperties: false,
      },
      Stack: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["stack"] },
          children: { type: "array", items: { $ref: "#/$defs/ViewNode" } },
          gap: { type: "integer", enum: [0, 1] },
        },
        required: ["type", "children"],
        additionalProperties: false,
      },
      Row: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["row"] },
          children: { type: "array", items: { $ref: "#/$defs/ViewNode" } },
          gap: { type: "integer", enum: [0, 1] },
        },
        required: ["type", "children"],
        additionalProperties: false,
      },
      Box: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["box"] },
          children: { type: "array", items: { $ref: "#/$defs/ViewNode" } },
          border: { type: "boolean" },
          padding: { type: "integer", enum: [0, 1] },
        },
        required: ["type", "children"],
        additionalProperties: false,
      },
      Divider: {
        type: "object",
        properties: { type: { type: "string", enum: ["divider"] } },
        required: ["type"],
        additionalProperties: false,
      },
      Grid: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["grid"] },
          columns: {
            type: "array",
            items: {
              type: "object",
              properties: { align: { type: "string", enum: ["left", "right", "center"] } },
              additionalProperties: false,
            },
          },
          rows: {
            type: "array",
            items: {
              type: "array",
              items: { $ref: "#/$defs/ViewNode" },
            },
          },
        },
        required: ["type", "rows"],
        additionalProperties: false,
      },
    },
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
  getTasks(): Task[];
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

function incompleteTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter((task) => task.status !== "done" && task.status !== "cancelled");
}

function taskCompletionNudge(tasks: readonly Task[]): string {
  const pending = incompleteTasks(tasks)
    .map((task) => `- ${task.id}: ${task.title} (${task.status})`)
    .join("\n");
  return [
    "You called submit_output, but your manage_tasks list still has unfinished items.",
    "Update the task list first: mark completed work as done, or continue/ask if anything is genuinely blocked.",
    "Unfinished tasks:",
    pending,
  ].join("\n");
}

class CodingDirectorImpl extends DefaultDirector implements CodingDirector {
  private submitCalled = false;
  private _turnsUsed = 0;
  private readonly callIdToName = new Map<string, string>();
  private readonly callIdToArgs = new Map<string, unknown>();
  private readonly filesReadAtTurn = new Map<string, number>();
  private idleCycles = 0;
  private tasks: Task[] = [];
  private readonly maxTurns: number | undefined;
  private readonly inactivityTimeoutMs: number | undefined;
  private readonly totalTimeoutMs: number | undefined;
  private terminated = false;
  private readonly workflowCalls = new Map<string, { name: string; args: unknown }>();
  private workflowCoordinator: WorkflowCoordinator | undefined;
  private workflowIdleTurns = 0;
  private readonly _systemPrompt: string;
  private _toolDefinitions: ToolDefinition[];
  private readonly compaction: CompactionGovernor;

  constructor(
    systemPrompt: string,
    toolDefinitions: ToolDefinition[],
    initialState?: DirectorPersistedState,
    maxTurns?: number,
    inactivityTimeoutMs?: number,
    totalTimeoutMs?: number,
    workflowCoordinator?: WorkflowCoordinator,
    requestContinuation?: () => void,
  ) {
    super(systemPrompt, toolDefinitions, {});
    this._systemPrompt = systemPrompt;
    this._toolDefinitions = toolDefinitions;
    this.maxTurns = maxTurns;
    this.inactivityTimeoutMs = inactivityTimeoutMs;
    this.totalTimeoutMs = totalTimeoutMs;
    this.workflowCoordinator = workflowCoordinator;
    this.compaction = createCompactionGovernor(requestContinuation);
    if (initialState !== undefined) {
      this.setState(initialState);
    }
  }

  setWorkflowCoordinator(coordinator: WorkflowCoordinator | undefined): void {
    this.workflowCoordinator = coordinator;
  }

  updateToolDefinitions(toolDefinitions: ToolDefinition[]): void {
    this._toolDefinitions = toolDefinitions;
  }

  getTasks(): Task[] {
    return [...this.tasks];
  }

  private withCurrentTools(
    result: ReactorAction | ReactorAction[],
  ): ReactorAction | ReactorAction[] {
    const active = this.workflowCoordinator?.isActive() === true;
    const tools = active && !this._toolDefinitions.some((t) => t.name === advanceWorkflowDefinition.name)
      ? [...this._toolDefinitions, advanceWorkflowDefinition]
      : this._toolDefinitions;
    const directive = active ? this.workflowCoordinator?.directive() ?? null : null;
    const rewrite = (action: ReactorAction): ReactorAction => {
      if (action.type !== "infer") return action;
      const options = { ...action.options, tools, retryPolicy: action.options?.retryPolicy ?? RETRY_POLICY };
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
      return [];
    }

    if (this.compaction.resumeAfterCompact(event)) {
      return capabilities.infer();
    }
    const recovery = this.compaction.interceptOverflow(event, capabilities);
    if (recovery !== null) return recovery;

    if (event.type === "inference.done") {
      this.compaction.noteInferenceDone(event, state?.turns?.length ?? 0);
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
          if (block.name === "manage_tasks") {
            const taskArgs = parseManageTasksArgs(block.arguments);
            if (taskArgs !== null) {
              this.tasks = applyManageTasks(this.tasks, taskArgs);
            }
          }
          if (block.name === "advance_workflow" || block.name === "submit_output") {
            this.workflowCalls.set(block.id, { name: block.name, args: block.arguments });
          }
        }
      }

      if (this.submitCalled) {
        if (!hasToolCalls) {
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
      if (this.workflowCalls.has(event.result.callId)) {
        const call = this.workflowCalls.get(event.result.callId);
        this.workflowCalls.delete(event.result.callId);
        const advanced = this.workflowCoordinator?.handleToolDone(call?.name, call?.args, event.result.isError === true);
        if (advanced) this.workflowIdleTurns = 0;
      }

      if (isOperatorDeclinedToolResult(event.result)) {
        this.callIdToName.delete(event.result.callId);
        this.callIdToArgs.delete(event.result.callId);
        this.terminated = true;
        return [
          capabilities.checkpoint("operator-declined"),
          capabilities.reply("Tool call rejected by operator."),
          capabilities.done(),
        ];
      }
      const name = this.callIdToName.get(event.result.callId);
      const submitArgs = this.callIdToArgs.get(event.result.callId);
      const isStepTagged = !(type({ step: "string" })(submitArgs) instanceof type.errors);
      if (name === "submit_output" && isSuccessfulToolResult(event.result) && !isStepTagged) {
        const unfinished = incompleteTasks(this.tasks);
        if (unfinished.length > 0) {
          this.submitCalled = false;
          this.callIdToName.delete(event.result.callId);
          this.callIdToArgs.delete(event.result.callId);
          return capabilities.infer({ systemPrompt: `${this._systemPrompt}\n\n${taskCompletionNudge(unfinished)}` });
        }
        this.submitCalled = true;
      }
      if (name === "read_file" && !event.result.isError) {
        const args = this.callIdToArgs.get(event.result.callId);
        const parsed = type({ path: "string" })(args);
        const path = parsed instanceof type.errors ? "" : parsed.path;
        if (path.length > 0) {
          this.filesReadAtTurn.set(path, this._turnsUsed);
        }
      }
      this.callIdToName.delete(event.result.callId);
      this.callIdToArgs.delete(event.result.callId);
    }

    const base = await super.decide(event, state, capabilities);

    const baseActions = Array.isArray(base) ? base : [base];
    const compacted = this.compaction.interceptActions(event, baseActions, capabilities);
    if (compacted !== null) return compacted;

    const coordinator = this.workflowCoordinator;
    if (coordinator?.isActive() && !coordinator.currentStepIsGate()) {
      const actions = Array.isArray(base) ? base : [base];
      const hasTerminal = actions.some((a) => a.type === "wait" || a.type === "reply");
      if (hasTerminal) {
        if (this.workflowIdleTurns >= 3) {
          return [capabilities.wait()];
        }
        const nudge = "\n\nYou have not yet called advance_workflow. " +
          "If this step is complete, call advance_workflow now. " +
          "Otherwise continue working with tools.";
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
      tasks: this.tasks,
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
    this.tasks = state.tasks ?? [];
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

const CODE_FILE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cc|cpp|h|hpp|rb|php|cs|swift|kt|kts|scala)$/i;

function isCodeFile(path: string): boolean {
  return CODE_FILE_EXT.test(path);
}

class ChatDirectorImpl extends DefaultDirector {
  private readonly workflowCalls = new Map<string, { name: string; args: unknown }>();
  private readonly lspTriggerCalls = new Set<string>();
  private readonly askOperatorCalls = new Set<string>();
  private readonly onActivateTools: ((names: string[]) => void) | undefined;
  private readonly taskClassifier:
    | ((message: string, metadata: SessionMetadata) => Promise<TaskBoundary>)
    | undefined;
  private readonly _systemPrompt: string;
  private _toolDefinitions: ToolDefinition[];
  private inactivityTimeoutMs: number | undefined;
  private totalTimeoutMs: number | undefined;
  private workflowCoordinator: WorkflowCoordinator | undefined;
  private workflowIdleTurns = 0;
  private lastInferenceTurnHadContent = false;
  private operatorJustResponded = false;
  private tasks: Task[] = [];
  private readonly onTasksChange: ((tasks: Task[]) => void) | undefined;
  private turnCount = 0;
  private currentTaskLabel: string | undefined;
  private lastTaskSummary: string | undefined;
  private startedAt = Date.now();
  private compactionPending = false;
  private idleCompactionPending = false;
  private postCompactInfer = false;
  private readonly requestContinuation: (() => void) | undefined;

  constructor(
    systemPrompt: string,
    toolDefinitions: ToolDefinition[],
    taskClassifier?: (message: string, metadata: SessionMetadata) => Promise<TaskBoundary>,
    onActivateTools?: (names: string[]) => void,
    inactivityTimeoutMs?: number,
    totalTimeoutMs?: number,
    workflowCoordinator?: WorkflowCoordinator,
    onTasksChange?: (tasks: Task[]) => void,
    requestContinuation?: () => void,
  ) {
    super(systemPrompt, toolDefinitions, {});
    this._systemPrompt = systemPrompt;
    this._toolDefinitions = toolDefinitions;
    this.inactivityTimeoutMs = inactivityTimeoutMs;
    this.totalTimeoutMs = totalTimeoutMs;
    this.taskClassifier = taskClassifier;
    this.onActivateTools = onActivateTools;
    this.workflowCoordinator = workflowCoordinator;
    this.onTasksChange = onTasksChange;
    this.requestContinuation = requestContinuation;
  }

  setWorkflowCoordinator(coordinator: WorkflowCoordinator | undefined): void {
    this.workflowCoordinator = coordinator;
  }

  updateToolDefinitions(toolDefinitions: ToolDefinition[]): void {
    this._toolDefinitions = toolDefinitions;
  }

  getTasks(): Task[] {
    return [...this.tasks];
  }

  private withCurrentTools(
    result: ReactorAction | ReactorAction[],
  ): ReactorAction | ReactorAction[] {
    const active = this.workflowCoordinator?.isActive() === true;
    const tools = active && !this._toolDefinitions.some((t) => t.name === advanceWorkflowDefinition.name)
      ? [...this._toolDefinitions, advanceWorkflowDefinition]
      : this._toolDefinitions;

    const directive = active ? this.workflowCoordinator?.directive() ?? null : null;

    const rewrite = (action: ReactorAction): ReactorAction => {
      if (action.type !== "infer") return action;
      const options = { ...action.options, tools, retryPolicy: action.options?.retryPolicy ?? RETRY_POLICY };
      if (this.inactivityTimeoutMs !== undefined) options.inactivityTimeoutMs = this.inactivityTimeoutMs;
      if (this.totalTimeoutMs !== undefined) options.totalTimeoutMs = this.totalTimeoutMs;
      const base = action.options?.systemPrompt ?? this._systemPrompt;
      let prompt = base;
      if (directive !== null) prompt = `${prompt}\n\n${directive}`;
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
    if (event.type === "message.received") {
      const content = typeof event.message.content === "string" ? event.message.content : "";
      if (content.length === 0 && this.postCompactInfer) {
        this.postCompactInfer = false;
        return capabilities.infer();
      }
      if (this.idleCompactionPending && (content.length === 0 || this.requestContinuation !== undefined)) {
        this.idleCompactionPending = false;
        this.compactionPending = false;
        if (content.length > 0) {
          this.postCompactInfer = true;
          this.requestContinuation?.();
        }
        return capabilities.compact("pruning-compactor", "context-threshold");
      }
    }

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
        if (block.name === "manage_tasks") {
          const taskArgs = parseManageTasksArgs(block.arguments);
          if (taskArgs !== null) {
            this.tasks = applyManageTasks(this.tasks, taskArgs);
            this.onTasksChange?.(this.tasks);
          }
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

    if (event.type === "tool.done" && this.workflowCalls.has(event.result.callId)) {
      const call = this.workflowCalls.get(event.result.callId);
      this.workflowCalls.delete(event.result.callId);
      const advanced = this.workflowCoordinator?.handleToolDone(call?.name, call?.args, event.result.isError === true);
      if (advanced) this.workflowIdleTurns = 0;
    }

    if (event.type === "tool.done" && this.askOperatorCalls.has(event.result.callId)) {
      this.askOperatorCalls.delete(event.result.callId);
      if (!event.result.isError) {
        this.operatorJustResponded = true;
      }
    }

    if (event.type === "tool.done" && this.lspTriggerCalls.has(event.result.callId)) {
      this.lspTriggerCalls.delete(event.result.callId);
      if (!event.result.isError) this.onActivateTools?.(["lsp"]);
    }

    if (event.type === "tool.done" && isOperatorDeclinedToolResult(event.result)) {
      if (operatorDeclinedHasMessage(event.result)) {
        return super.decide(event, state, capabilities);
      }
      return [
        capabilities.checkpoint("operator-declined"),
        capabilities.reply("Tool call rejected by operator."),
      ];
    }

    if (event.type === "inference.done") {
      const currentContextTokens = event.usage?.input ?? 0;
      const compactThreshold = compactionThresholdFor(event.source?.model);
      if (currentContextTokens > compactThreshold && state.turns.length > 6) {
        this.compactionPending = true;
      }
    }

    const base = await super.decide(event, state, capabilities);

    if (this.compactionPending && event.type === "inference.done") {
      const actions = Array.isArray(base) ? base : [base];
      const terminalWithoutFollowup = actions.some((a) => a.type === "reply" || a.type === "wait") &&
        !actions.some((a) => a.type === "infer" || a.type === "execute_tools");
      if (terminalWithoutFollowup && !this.idleCompactionPending) {
        this.idleCompactionPending = true;
        this.requestContinuation?.();
      }
    }

    if (
      this.compactionPending &&
      event.type === "tool.done"
    ) {
      const actions = Array.isArray(base) ? base : [base];
      const hasInfer = actions.some((a) => a.type === "infer");
      if (hasInfer) {
        this.compactionPending = false;
        this.postCompactInfer = true;
        this.requestContinuation?.();
        const filtered = actions.filter((a) => a.type !== "infer");
        return [
          ...filtered,
          capabilities.compact("pruning-compactor", "context-threshold"),
        ];
      }
    }

    const coordinator = this.workflowCoordinator;
    if (coordinator?.isActive() && !coordinator.currentStepIsGate()) {
      const actions = Array.isArray(base) ? base : [base];
      const hasTerminal = actions.some((a) => a.type === "wait" || a.type === "reply");
      if (hasTerminal && this.lastInferenceTurnHadContent) {
        if (this.operatorJustResponded) {
          this.operatorJustResponded = false;
          return base;
        }
        if (this.workflowIdleTurns >= 3) {
          return [
            capabilities.reply(
              "The workflow appears stuck on this step. Send a message to continue or advance manually.",
            ),
          ];
        }
        const nudge = "\n\nYou have not yet called advance_workflow. " +
          "If this step is complete, call advance_workflow now. " +
          "Otherwise continue working with tools.";
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

  signalNewTask(summary?: string): void {
    this.currentTaskLabel = undefined;
    this.lastTaskSummary = summary;
    this.tasks = [];
    this.onTasksChange?.(this.tasks);
  }
}

export function createChatDirector(
  systemPrompt: string,
  toolDefinitions: ToolDefinition[],
  taskClassifier?: (message: string, metadata: SessionMetadata) => Promise<TaskBoundary>,
  onActivateTools?: (names: string[]) => void,
  inactivityTimeoutMs?: number,
  totalTimeoutMs?: number,
  workflowCoordinator?: WorkflowCoordinator,
  onTasksChange?: (tasks: Task[]) => void,
  requestContinuation?: () => void,
): ChatDirectorWithClear {
  return new ChatDirectorImpl(
    systemPrompt,
    toolDefinitions,
    taskClassifier,
    onActivateTools,
    inactivityTimeoutMs,
    totalTimeoutMs,
    workflowCoordinator,
    onTasksChange,
    requestContinuation,
  );
}

export interface ChatDirectorWithClear extends ReactorDirector {
  signalNewTask(summary?: string): void;
  updateToolDefinitions(toolDefinitions: ToolDefinition[]): void;
  setWorkflowCoordinator(coordinator: WorkflowCoordinator | undefined): void;
  getTasks(): Task[];
}
