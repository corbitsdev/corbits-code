import { DefaultDirector, type ExtendedInferenceOptions } from "@intx/inference";
import { getLogger } from "@intx/log";
import type {
  ReactorDirector,
  ReactorInboundEvent,
  ReactorState,
  ReactorCapabilities,
  ReactorAction,
  ToolDefinition,
  ConversationTurn,
} from "@intx/types/runtime";
import {
  type SessionMetadata,
  type TaskBoundary,
} from "../session/compactor.js";
import type { WorkflowCoordinator } from "../workflows/coordinator.js";
import { createCompactionGovernor, type CompactionGovernor } from "./compaction.js";
import { onTurnBoundary } from "./reactor-events.js";
import { type } from "arktype";
import { applyManageTasks, hasActiveTasks, parseManageTasksArgs, type Task } from "./tasks.js";
import { createCorbitsRetryPolicy } from "./retry-policy.js";
import { isInternalRecoveryAbortRaw } from "../inference-abort.js";
import { LOG_NAMESPACE_ROOT } from "../branding.js";
import { resolveModelFamilyPolicy, type ModelFamilyPolicy } from "./model-family-policy.js";
import { PRESENT_VIEW_PRIMITIVES_GUIDANCE } from "./tool-schema-normalize.js";

const RETRY_POLICY = createCorbitsRetryPolicy();

const logger = getLogger([LOG_NAMESPACE_ROOT, "agent", "director"]);

function isInternalRecoveryAbort(event: Extract<ReactorInboundEvent, { type: "inference.error" }>): boolean {
  return isInternalRecoveryAbortRaw(event.error.raw);
}

function directorNudgeTurn(text: string): ConversationTurn {
  return {
    role: "user",
    content: [{ type: "text", text: text.trim() }],
    timestamp: Date.now(),
  };
}

function withEphemeralNudge(options: ExtendedInferenceOptions, nudge: string): ExtendedInferenceOptions {
  const turn = directorNudgeTurn(nudge);
  const existing = options.ephemeralTurns;
  if (existing === undefined || existing.length === 0) {
    return { ...options, ephemeralTurns: [turn] };
  }
  return { ...options, ephemeralTurns: [...existing, turn] };
}

function inferWithNudge(
  capabilities: ReactorCapabilities,
  nudge: string,
  options?: ExtendedInferenceOptions,
): ReactorAction {
  return capabilities.infer(withEphemeralNudge(options ?? {}, nudge));
}

// agent.send() only resolves on connector.reply (or fatal shutdown). A bare
// wait leaves the send promise hanging and the TUI Working spinner stuck.
// When the cycle is ending with wait and no further work, emit an empty reply
// so the connector settles. Empty content does not paint a transcript block.
//
// Assumes a bare wait always means the turn is over. That holds for every
// current wait path: DefaultDirector in conversational mode (the only mode
// ChatDirector uses) yields a bare wait only on an empty model turn, and its
// halt path already carries a reply; the compaction, workflow, open-task, and
// goal rewrites either keep those terminals or replace them with an infer.
// A future wait that pauses mid-turn while expecting more work must not be
// settled here.
function ensureCycleSettlesWithReply(
  actions: ReactorAction | ReactorAction[],
  capabilities: ReactorCapabilities,
): ReactorAction | ReactorAction[] {
  const list = Array.isArray(actions) ? actions : [actions];
  if (!list.some((a) => a.type === "wait")) return actions;
  if (list.some((a) => a.type === "infer" || a.type === "execute_tools" || a.type === "reply")) {
    return actions;
  }
  return [capabilities.reply(""), ...list];
}

// A terminal decision with tasks still open means the work was not finished or
// not marked finished. Rather than idle there, the director re-infers with a
// nudge a bounded number of times, then logs the invariant breach and lets the
// session end. Both budgets reset only on the next inbound user message (see
// decideInner), not on any tool call in between, so a model that spins on
// no-op tool calls within one turn still converges to the cap.
const MAX_OPEN_TASK_NUDGES = 3;
const MAX_DECLINED_OPEN_TASK_NUDGES = 2;
const MAX_INFERENCE_RECOVERIES = 2;

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
    PRESENT_VIEW_PRIMITIVES_GUIDANCE +
    " " +
    "Keep it compact; the UI handles width and scrolling. " +
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

// Single implementation of "what does a manage_tasks tool call do to the
// task list", shared by the live decide() loop below and hydrateTasksFromTurns.
// Task state is owned by the director, not by the tool: manage_tasks's
// handler (src/agent/tools.ts) performs no side effect of its own — it
// parses the same arguments and returns a fixed "Tasks updated." string. The
// tool_call is therefore the authoritative event, and applying it here does
// not need to wait on a tool_result the handler never varies.
// Returns null when the call is not manage_tasks or its arguments don't
// parse, so callers can distinguish "no valid manage_tasks call here" from
// "a valid call that happened to be a no-op" — the latter still counts as an
// update for onTasksChange purposes.
function applyManageTasksToolCall(tasks: Task[], block: { name: string; arguments: unknown }): Task[] | null {
  if (block.name !== "manage_tasks") return null;
  const taskArgs = parseManageTasksArgs(block.arguments);
  return taskArgs !== null ? applyManageTasks(tasks, taskArgs) : null;
}

export type ChatDirectorOptions = {
  taskClassifier?: ((message: string, metadata: SessionMetadata) => Promise<TaskBoundary>) | undefined;
  onActivateTools?: ((names: string[]) => void) | undefined;
  inactivityTimeoutMs?: number | undefined;
  totalTimeoutMs?: number | undefined;
  workflowCoordinator?: WorkflowCoordinator | undefined;
  onTasksChange: (tasks: Task[]) => void;
  requestContinuation?: (() => void) | undefined;
  provider?: { providerName: string; model?: string } | undefined;
};

// The constructor takes the resolved ModelFamilyPolicy rather than the raw
// `provider` input the factory function accepts and resolves on its behalf.
type ChatDirectorImplOptions = Omit<ChatDirectorOptions, "provider"> & {
  modelFamilyPolicy?: ModelFamilyPolicy | undefined;
};

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
  private inferenceRecoveries = 0;
  private lastInferenceTurnHadContent = false;
  private operatorJustResponded = false;
  private tasks: Task[] = [];
  private readonly onTasksChange: ((tasks: Task[]) => void) | undefined;
  private turnCount = 0;
  private currentTaskLabel: string | undefined;
  private lastTaskSummary: string | undefined;
  private startedAt = Date.now();
  private readonly compaction: CompactionGovernor;
  private readonly modelFamilyPolicy: ModelFamilyPolicy;
  // Consecutive assistant turns that contain tool calls and no text. Reset on
  // any turn with text and on every fresh user message — a weak model that
  // spins in place on one thread of tool calls still converges to the pause,
  // regardless of what it calls in between (same reset discipline as the
  // idle/declined nudge budgets above).
  private toolOnlyStreak = 0;
  private toolOnlyNudgeFired = false;
  private pendingToolOnlyNudge = false;
  private pausedForToolOnly = false;

  constructor(systemPrompt: string, toolDefinitions: ToolDefinition[], options: ChatDirectorImplOptions) {
    super(systemPrompt, toolDefinitions, {});
    this._systemPrompt = systemPrompt;
    this._toolDefinitions = toolDefinitions;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs;
    this.totalTimeoutMs = options.totalTimeoutMs;
    this.taskClassifier = options.taskClassifier;
    this.onActivateTools = options.onActivateTools;
    this.workflowCoordinator = options.workflowCoordinator;
    this.onTasksChange = options.onTasksChange;
    this.compaction = createCompactionGovernor(options.requestContinuation, systemPrompt, toolDefinitions);
    this.modelFamilyPolicy = options.modelFamilyPolicy ?? resolveModelFamilyPolicy({ providerName: "" });
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

  // A resumed session's task list lives in the transcript, not in the freshly
  // constructed director. Without this the chrome panel would read an empty
  // list until the model happened to call manage_tasks again, disagreeing
  // with the task block already painted in the transcript.
  restoreTasks(tasks: Task[]): void {
    this.tasks = [...tasks];
    this.onTasksChange?.(this.tasks);
  }

  // The status bar's context meter falls back to this when a provider omits
  // or zeroes usage on the latest turn — a local lower-then-corrected bound
  // beats displaying a number the provider never actually reported.
  getContextEstimate(): { tokens: number; isEstimate: boolean } {
    return { tokens: this.compaction.estimatedTokens, isEstimate: this.compaction.usingEstimate };
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

  /**
   * Rewrites the infer action in a fall-through batch once pending tool
   * calls have resolved: pause wins over a still-armed nudge (the streak
   * only grows past pauseAt after nudgeAt), and each rewrite is one-shot —
   * cleared as soon as it is actually applied to an infer.
   */
  private applyToolOnlyLoopProtection(
    actions: ReactorAction[],
    capabilities: ReactorCapabilities,
  ): ReactorAction[] | null {
    if (!this.pausedForToolOnly && !this.pendingToolOnlyNudge) return null;
    const inferIndex = actions.findIndex((a) => a.type === "infer");
    if (inferIndex === -1) return null;

    if (this.pausedForToolOnly) {
      const pauseMessage =
        `Auto-paused: the model ran ${this.toolOnlyStreak} steps in a row without explaining its progress. ` +
        "Send a message to resume.";
      return [
        capabilities.checkpoint("tool-only-loop-paused"),
        capabilities.reply(pauseMessage),
      ];
    }

    this.pendingToolOnlyNudge = false;
    const rewritten = [...actions];
    const existing = actions[inferIndex] as Extract<ReactorAction, { type: "infer" }>;
    rewritten[inferIndex] = inferWithNudge(
      capabilities,
      this.modelFamilyPolicy.wrapUpNudgeText,
      existing.options,
    );
    return rewritten;
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
      if (directive !== null) {
        return {
          type: "infer",
          options: withEphemeralNudge(options, directive),
        };
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
    const settled = ensureCycleSettlesWithReply(
      await this.decideInner(event, state, capabilities),
      capabilities,
    );
    return this.withCurrentTools(settled);
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

    if (event.type === "inference.error" &&
      (event.error.category === "timeout" ||
        event.error.category === "retryable" ||
        (event.error.category === "aborted" && isInternalRecoveryAbort(event)))) {
      if (this.inferenceRecoveries < MAX_INFERENCE_RECOVERIES) {
        this.inferenceRecoveries++;
        return [capabilities.checkpoint("inference-recovery"), capabilities.infer()];
      }
      return [
        capabilities.checkpoint("inference-recovery-exhausted"),
        capabilities.reply("The request could not recover. Send a message to resume."),
      ];
    }

    // Both nudge budgets are monotonic per inbound user message rather than
    // resetting on "real" tool work. Classifying a tool call as progress is
    // gameable: a weak model learns that any tool call (including a no-op
    // `echo`) buys back budget, so it narrates instead of finishing. Resetting
    // only on a fresh message means a model that spins in place on one turn
    // always converges to the cap, regardless of what it calls in between.
    if (event.type === "message.received") {
      this.idleTerminationNudges = 0;
      this.declinedTerminationNudges = 0;
      this.inferenceRecoveries = 0;
      this.toolOnlyStreak = 0;
      this.toolOnlyNudgeFired = false;
      this.pendingToolOnlyNudge = false;
      this.pausedForToolOnly = false;
    }
    if (onTurnBoundary(event)) this.inferenceRecoveries = 0;

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
            capabilities.infer(
              withEphemeralNudge(
                {
                  systemPrompt: this._systemPrompt,
                  tools: this._toolDefinitions,
                },
                envelope,
              ),
            ),
          ];
        }
      } catch {
        // Classifier failure should not break the session. Fall through to infer.
      }
    }

    if (onTurnBoundary(event)) {
      this.turnCount++;
      const hasToolCalls = event.turn.content.some((b) => b.type === "tool_call");
      const hasText = event.turn.content.some(
        (b) => b.type === "text" && typeof b.text === "string" && b.text.length > 0,
      );
      this.lastInferenceTurnHadContent = hasToolCalls || hasText;

      // Main-session loop protection: a run of tool-only turns (tool calls,
      // no narration) is the shape of a runaway session an operator would
      // otherwise have to notice and cancel by hand. A dismissed
      // ask_operator counts toward this streak like any other tool-only turn
      // (handled separately below; declined-tool early returns do not reset
      // the streak because only text turns and fresh messages do).
      if (hasToolCalls && !hasText) {
        this.toolOnlyStreak++;
      } else {
        this.toolOnlyStreak = 0;
        this.toolOnlyNudgeFired = false;
        this.pendingToolOnlyNudge = false;
        this.pausedForToolOnly = false;
      }
      if (this.toolOnlyStreak >= this.modelFamilyPolicy.toolOnlyTurnPauseAt) {
        this.pausedForToolOnly = true;
      } else if (
        this.toolOnlyStreak === this.modelFamilyPolicy.toolOnlyTurnNudgeAt &&
        !this.toolOnlyNudgeFired
      ) {
        this.toolOnlyNudgeFired = true;
        this.pendingToolOnlyNudge = true;
      }

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
          const next = applyManageTasksToolCall(this.tasks, block);
          if (next !== null) {
            this.tasks = next;
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
            inferWithNudge(capabilities, DECLINED_OPEN_TASK_NUDGE),
          ];
        }
        this.logTerminationWithOpenTasks("operator-declined");
      }
      return [
        capabilities.checkpoint("operator-declined"),
        capabilities.reply("Tool call rejected by operator."),
      ];
    }

    // Keep the running local estimate current on every cycle (tool results and
    // rewrites included). Arming still happens inside noteInferenceDone, which
    // prefers provider usage when present.
    const turns = state.turns ?? [];
    this.compaction.syncFromTurns(turns);
    if (onTurnBoundary(event)) {
      this.compaction.noteInferenceDone(event, turns);
    }

    const base = await super.decide(event, state, capabilities);
    const baseActions = Array.isArray(base) ? base : [base];

    this.compaction.noteIdleTurn(event, baseActions);
    const compacted = this.compaction.interceptActions(event, baseActions, capabilities);
    if (compacted !== null) return compacted;

    // Loop protection takes precedence over workflow/open-task
    // continuation nudges below: those exist to keep a session moving,
    // which is exactly the behavior the pause is guarding against. A tool
    // call turn (like the one that triggered this) must still execute
    // before any nudge or pause can land — a bare user turn on top of
    // pending tool_calls is a provider-invalid conversation — so this only
    // rewrites an `infer` action once pending tools have resolved and one
    // is actually present in the batch (mirrors the sub-agent report-forced
    // wiring in src/subagent/index.ts).
    const toolOnlyRewrite = this.applyToolOnlyLoopProtection(baseActions, capabilities);
    if (toolOnlyRewrite !== null) return toolOnlyRewrite;

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
        const passThrough = actions.filter(
          (a): a is Exclude<ReactorAction, { type: "wait" } | { type: "reply" }> =>
            a.type !== "wait" && a.type !== "reply",
        );
        return [...passThrough, inferWithNudge(capabilities, nudge)];
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
            inferWithNudge(capabilities, nudge),
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
  options: ChatDirectorOptions,
): ChatDirector {
  const { provider, ...rest } = options;
  return new ChatDirectorImpl(systemPrompt, toolDefinitions, {
    ...rest,
    // `provider` is raw {providerName, model} input; the constructor wants
    // the resolved ModelFamilyPolicy, not the input it was resolved from.
    modelFamilyPolicy: provider !== undefined ? resolveModelFamilyPolicy(provider) : undefined,
  });
}

// Uses the same applyManageTasksToolCall a live session's decide() loop uses,
// so hydrate necessarily reaches the same task state live decide() would
// have produced from this transcript: the tool_call is the authoritative
// event (see applyManageTasksToolCall), and there is only the one function
// that knows how to turn a manage_tasks call into a task list.
export function hydrateTasksFromTurns(turns: ConversationTurn[]): Task[] {
  let tasks: Task[] = [];
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    for (const block of turn.content) {
      if (block.type !== "tool_call") continue;
      const next = applyManageTasksToolCall(tasks, block);
      if (next !== null) tasks = next;
    }
  }
  return tasks;
}

export interface ChatDirector extends ReactorDirector {
  updateToolDefinitions(toolDefinitions: ToolDefinition[]): void;
  setWorkflowCoordinator(coordinator: WorkflowCoordinator | undefined): void;
  getTasks(): Task[];
  restoreTasks(tasks: Task[]): void;
  getContextEstimate(): { tokens: number; isEstimate: boolean };
}
