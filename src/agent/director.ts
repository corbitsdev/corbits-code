import { DefaultDirector } from "@intx/inference";
import { getLogger } from "@intx/log";
import type {
  ReactorDirector,
  ReactorInboundEvent,
  ReactorState,
  ReactorCapabilities,
  ReactorAction,
  ToolDefinition,
} from "@intx/types/runtime";
import {
  type SessionMetadata,
  type TaskBoundary,
} from "../session/compactor.js";
import type { WorkflowCoordinator } from "../workflows/coordinator.js";
import { createCompactionGovernor, type CompactionGovernor } from "./compaction.js";
import { type } from "arktype";
import { applyManageTasks, hasActiveTasks, parseManageTasksArgs, type Task } from "./tasks.js";
import { createIntercodeRetryPolicy } from "./retry-policy.js";

const RETRY_POLICY = createIntercodeRetryPolicy();

const logger = getLogger(["intercode", "agent", "director"]);

// A terminal decision with tasks still open means the work was not finished or
// not marked finished. Rather than idle there, the director re-infers with a
// nudge a bounded number of times, then logs the invariant breach and lets the
// session end. Both budgets reset only on the next inbound user message (see
// decideInner), not on any tool call in between, so a model that spins on
// no-op tool calls within one turn still converges to the cap.
const MAX_OPEN_TASK_NUDGES = 3;
const MAX_DECLINED_OPEN_TASK_NUDGES = 2;

const IDLE_OPEN_TASK_NUDGE =
  "\n\nYou are ending your turn while tasks are still open (todo/doing). " +
  "Finish the remaining work and mark each task done or cancelled with " +
  "manage_tasks before ending, or continue working with tools.";

const WORKFLOW_OPEN_TASK_NUDGE =
  "\n\nYou are ending your turn while tasks are still open (todo/doing) and a " +
  "workflow step is active. Continue working with tools, call advance_workflow " +
  "once the step is complete, or mark finished tasks done with manage_tasks. " +
  "Do not end your turn with tasks still open.";

const DECLINED_OPEN_TASK_NUDGE =
  "\n\nThe operator declined the tool call. Do not retry the declined action. " +
  "Some tasks are still open (todo/doing): either take a different approach " +
  "that does not need the declined action, or mark those tasks cancelled with " +
  "manage_tasks. Do not end your turn with tasks still open.";

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
  private idleTerminationNudges = 0;
  private declinedTerminationNudges = 0;
  private lastInferenceTurnHadContent = false;
  private operatorJustResponded = false;
  private tasks: Task[] = [];
  private readonly onTasksChange: ((tasks: Task[]) => void) | undefined;
  private turnCount = 0;
  private currentTaskLabel: string | undefined;
  private lastTaskSummary: string | undefined;
  private startedAt = Date.now();
  private readonly compaction: CompactionGovernor;

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
    this.compaction = createCompactionGovernor(requestContinuation);
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

  private openTaskIds(): string[] {
    return this.tasks
      .filter((t) => t.status === "todo" || t.status === "doing")
      .map((t) => t.id);
  }

  private logTerminationWithOpenTasks(path: string): void {
    logger.error(
      "Director reached a terminal decision on {path} with open tasks: {openTasks}",
      { path, openTasks: this.openTaskIds() },
    );
  }

  private withCurrentTools(
    result: ReactorAction | ReactorAction[],
  ): ReactorAction | ReactorAction[] {
    const active = this.workflowCoordinator?.isActive() === true;
    // advance_workflow rides on the wire every turn, workflow or not, so
    // activating a workflow never grows the tools array and busts the cache
    // prefix. Outside a workflow it is a harmless no-op the director ignores.
    const tools = this._toolDefinitions.some((t) => t.name === advanceWorkflowDefinition.name)
      ? this._toolDefinitions
      : [...this._toolDefinitions, advanceWorkflowDefinition];

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
    if (this.compaction.resumeAfterCompact(event)) {
      return capabilities.infer();
    }
    const idleCompact = this.compaction.interceptIdleContinuation(event, capabilities);
    if (idleCompact !== null) return idleCompact;
    const recovery = this.compaction.interceptOverflow(event, capabilities);
    if (recovery !== null) return recovery;

    // Both nudge budgets are monotonic per inbound user message rather than
    // resetting on "real" tool work. Classifying a tool call as progress is
    // gameable: a weak model learns that any tool call (including a no-op
    // `echo`) buys back budget, so it narrates instead of finishing. Resetting
    // only on a fresh message means a model that spins in place on one turn
    // always converges to the cap, regardless of what it calls in between.
    if (event.type === "message.received") {
      this.idleTerminationNudges = 0;
      this.declinedTerminationNudges = 0;
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
      if (hasActiveTasks(this.tasks)) {
        if (this.declinedTerminationNudges < MAX_DECLINED_OPEN_TASK_NUDGES) {
          this.declinedTerminationNudges++;
          return [
            capabilities.checkpoint("operator-declined"),
            capabilities.infer({ systemPrompt: `${this._systemPrompt}${DECLINED_OPEN_TASK_NUDGE}` }),
          ];
        }
        this.logTerminationWithOpenTasks("operator-declined");
      }
      return [
        capabilities.checkpoint("operator-declined"),
        capabilities.reply("Tool call rejected by operator."),
      ];
    }

    if (event.type === "inference.done") {
      this.compaction.noteInferenceDone(event, state?.turns?.length ?? 0);
    }

    const base = await super.decide(event, state, capabilities);
    const baseActions = Array.isArray(base) ? base : [base];

    this.compaction.noteIdleTurn(event, baseActions);
    const compacted = this.compaction.interceptActions(event, baseActions, capabilities);
    if (compacted !== null) return compacted;

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
          if (hasActiveTasks(this.tasks)) this.logTerminationWithOpenTasks("workflow-idle-stall");
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

    // A workflow gate step is a legitimate pause for operator approval, so
    // yielding there with open tasks is not an invariant breach — leave it to
    // the workflow runtime and do not nudge.
    const atWorkflowGate =
      coordinator?.isActive() === true && coordinator.currentStepIsGate();
    if (!atWorkflowGate && hasActiveTasks(this.tasks)) {
      const hasTerminal = baseActions.some((a) => a.type === "wait" || a.type === "reply");
      if (hasTerminal) {
        if (this.idleTerminationNudges < MAX_OPEN_TASK_NUDGES) {
          this.idleTerminationNudges++;
          const passThrough = baseActions.filter(
            (a): a is Exclude<ReactorAction, { type: "wait" } | { type: "reply" }> =>
              a.type !== "wait" && a.type !== "reply",
          );
          // Inside a workflow the terminal action is advance_workflow, so point
          // the nudge at it rather than the general manage_tasks guidance.
          const nudge = coordinator?.isActive() === true ? WORKFLOW_OPEN_TASK_NUDGE : IDLE_OPEN_TASK_NUDGE;
          return [
            ...passThrough,
            capabilities.infer({ systemPrompt: `${this._systemPrompt}${nudge}` }),
          ];
        }
        this.logTerminationWithOpenTasks("idle-stall");
      }
    }

    return base;
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
): ChatDirector {
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

export interface ChatDirector extends ReactorDirector {
  updateToolDefinitions(toolDefinitions: ToolDefinition[]): void;
  setWorkflowCoordinator(coordinator: WorkflowCoordinator | undefined): void;
  getTasks(): Task[];
}
