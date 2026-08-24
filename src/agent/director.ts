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
  RetryPolicy,
} from "@intx/types/runtime";
import { type SessionMetadata, type TaskBoundary } from "../session/compactor.js";
import type { WorkflowCoordinator } from "../workflows/coordinator.js";
import { createCompactionGovernor, type CompactionGovernor } from "./compaction.js";
import { onTurnBoundary } from "./reactor-events.js";
import { type } from "arktype";
import { applyManageTasks, hasActiveTasks, parseManageTasksArgs, type Task } from "./tasks.js";
import { createCorbitsRetryPolicy } from "./retry-policy.js";
import { isInternalRecoveryAbortRaw } from "../inference-abort.js";
import { LOG_NAMESPACE_ROOT } from "../branding.js";
import { resolveModelFamilyPolicy, type ModelFamilyPolicy } from "./model-family-policy.js";
import {
  fingerprintToolCalls,
  detectToolFingerprintThrash,
  detectTurnsSinceUserMessageBackstop,
  TURNS_SINCE_USER_MESSAGE_BACKSTOP,
  MAX_LEAF_PROGRESS_BACKSTOP_RESETS,
  TOOL_FINGERPRINT_HISTORY_CAP,
  type ToolFingerprintThrashCheck,
} from "../subagent/stop-policy.js";
import { PRESENT_VIEW_PRIMITIVES_GUIDANCE } from "./tool-schema-normalize.js";
import { isOperatorOriginated } from "./message-provenance.js";
import { classifyBriefSalvage, isHardBlockSalvage } from "../subagent/brief-dispatch.js";
import type { ForcedStopReason } from "../subagent/stop-policy.js";
import { PRIMARY_SALVAGE_NUDGE } from "./look-tour.js";

// Fired when turnsSinceUserMessage reaches TURNS_SINCE_USER_MESSAGE_BACKSTOP.
// A nudge, not a pause — the operator explicitly wants long autonomous runs
// to keep going, so silence alone (with no detected cycle) is not
// sufficient grounds to stop. Only ignoring this request for a further full
// backstop interval escalates to a hard pause.
const BACKSTOP_NUDGE_TEXT =
  "It has been a long stretch without a message from the operator. Send a brief progress summary — what has been done, what is left — so the operator can confirm you're still on track.";

const logger = getLogger([LOG_NAMESPACE_ROOT, "agent", "director"]);

function isInternalRecoveryAbort(
  event: Extract<ReactorInboundEvent, { type: "inference.error" }>,
): boolean {
  return isInternalRecoveryAbortRaw(event.error.raw);
}

function directorNudgeTurn(text: string): ConversationTurn {
  return {
    role: "user",
    content: [{ type: "text", text: text.trim() }],
    timestamp: Date.now(),
  };
}

function withEphemeralNudge(
  options: ExtendedInferenceOptions,
  nudge: string,
): ExtendedInferenceOptions {
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
// halt path already carries a reply; the compaction, workflow, and open-task
// rewrites either keep those terminals or replace them with an infer.
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
          tone: {
            type: "string",
            enum: ["default", "muted", "success", "warning", "danger", "accent"],
          },
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
        description:
          "Workflow step ID to advance. When present this is a " +
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
function applyManageTasksToolCall(
  tasks: Task[],
  block: { name: string; arguments: unknown },
): Task[] | null {
  if (block.name !== "manage_tasks") return null;
  const taskArgs = parseManageTasksArgs(block.arguments);
  return taskArgs !== null ? applyManageTasks(tasks, taskArgs) : null;
}

export interface ChatDirectorOptions {
  taskClassifier?:
    ((message: string, metadata: SessionMetadata) => Promise<TaskBoundary>) | undefined;
  onActivateTools?: ((names: string[]) => void) | undefined;
  inactivityTimeoutMs?: number | undefined;
  totalTimeoutMs?: number | undefined;
  workflowCoordinator?: WorkflowCoordinator | undefined;
  onTasksChange: (tasks: Task[]) => void;
  requestContinuation?: (() => void) | undefined;
  provider?: { providerName: string; model?: string } | undefined;
  /**
   * Live catalog provider id for retry stamping. Resolved on each retry
   * decision so mid-session `/model` switches remapping without rebuilding
   * the agent. When set, preferred over static `provider.providerName`.
   */
  getProviderId?: (() => string | undefined) | undefined;
  /** Explicit retry policy; when set, skips the default Corbits policy. */
  retryPolicy?: RetryPolicy | undefined;
}

// The constructor takes the resolved ModelFamilyPolicy rather than the raw
// `provider` input the factory function accepts and resolves on its behalf.
type ChatDirectorImplOptions = Omit<ChatDirectorOptions, "provider"> & {
  modelFamilyPolicy?: ModelFamilyPolicy | undefined;
  /** Provider-stamped retry policy (xAI short 429 remapping needs providerId). */
  retryPolicy?: RetryPolicy | undefined;
};

class ChatDirectorImpl extends DefaultDirector {
  private readonly workflowCalls = new Map<string, { name: string; args: unknown }>();
  private readonly lspTriggerCalls = new Set<string>();
  private readonly askOperatorCalls = new Set<string>();
  private readonly onActivateTools: ((names: string[]) => void) | undefined;
  private readonly taskClassifier:
    ((message: string, metadata: SessionMetadata) => Promise<TaskBoundary>) | undefined;
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
  private readonly retryPolicy: RetryPolicy;
  // Consecutive assistant turns that contain tool calls and no text. Reset on
  // any turn with text and on every fresh user message — a weak model that
  // spins in place on one thread of tool calls still converges to the
  // check-in nudge, regardless of what it calls in between (same reset
  // discipline as the idle/declined nudge budgets above). This streak only
  // drives the soft check-in nudge at toolOnlyTurnNudgeAt; the hard pause
  // normally requires the tool-fingerprint history to actually repeat as a
  // cycle (see applyToolOnlyLoopProtection and detectToolFingerprintThrash).
  private toolOnlyStreak = 0;
  private toolOnlyNudgeFired = false;
  private pendingToolOnlyNudge = false;
  private pausedForToolOnly = false;
  // Rolling tail of tool-only-turn fingerprints, capped so a very long
  // productive streak (200+ turns) doesn't grow the buffer or per-turn period
  // scan unbounded — detection only ever looks at the tail. Cleared on any
  // narrated turn (narration is legitimate evidence the model is not
  // cycling) and on a fresh user message.
  private toolFingerprintHistory: string[] = [];
  private lastThrashCheck: ToolFingerprintThrashCheck | null = null;
  // Turns since the operator last sent a genuine message — the raw backstop
  // counter. Unlike toolFingerprintHistory, this is NOT cleared by narrated
  // turns: model-emitted text is not evidence the operator has seen a
  // checkpoint, so it must not buy back backstop budget (round-4 fix for a
  // model that resets a narration-sensitive counter with one word every N
  // turns). Only a message.received event whose message carries
  // OPERATOR_ORIGINATED_FLAG resets it — not every message.received, since
  // synthetic system sends (compaction continuations, retries, future
  // director continuations) fire that event too without being operator
  // input (round-5 fix; see message-provenance.ts for the flag's invariant).
  // CL-5893: also reset (without being treated as an operator message) by a
  // successful leaf task tool.done — see the pendingTaskCallIds handling
  // below — so a parent productively blocked on long-running task calls does
  // not hard-pause purely from turn volume; a true no-progress tool-only
  // loop with no successful completions is unaffected.
  // Increments on every turn boundary, tool-only or narrated alike.
  private turnsSinceUserMessage = 0;
  // Set to the turnsSinceUserMessage value at which the backstop nudge fired,
  // so the escalation check can require a full further backstop interval to
  // elapse (still with no user message and no period-detected thrash) before
  // hard-pausing. Reset to null on an operator-originated message or a
  // successful leaf task completion (CL-5893); it
  // is NOT reset when thrash detection or the escalation pause fires —
  // pausedForToolOnly and toolOnlyPauseReason are recomputed fresh every
  // turn instead, so a stale non-null value here is harmless once a pause
  // is in effect (the next operator message clears both together).
  private backstopNudgeFiredAtTurn: number | null = null;
  private pendingBackstopNudge = false;
  // CL-5893: how many times a successful leaf task completion has re-armed
  // the backstop since the last genuine operator message. Capped at
  // MAX_LEAF_PROGRESS_BACKSTOP_RESETS so an unbroken run of trivial
  // always-succeeding leaf tasks cannot reset the backstop forever — once
  // exhausted, leaf successes stop resetting the interval and the ordinary
  // nudge/pause escalation proceeds. Reset to 0 only alongside the other
  // operator-message resets below, never by the leaf-success path itself.
  private leafProgressBackstopResets = 0;
  // Which mechanism triggered pausedForToolOnly — the period-detection fast
  // path (a recognized cycle) or the backstop escalation (nudge went
  // unheeded for a further full interval with no user message). Drives the
  // pause message wording so the two are distinguishable.
  private toolOnlyPauseReason: "thrash" | "backstop" | null = null;
  // One-shot nudge after a hard-block worker salvage. Not a look-count quota.
  private salvageNudgeFired = false;
  private pendingSalvageNudge: string | null = null;
  private pendingTaskCallIds = new Set<string>();

  constructor(
    systemPrompt: string,
    toolDefinitions: ToolDefinition[],
    options: ChatDirectorImplOptions,
  ) {
    super(systemPrompt, toolDefinitions, {});
    this._systemPrompt = systemPrompt;
    this._toolDefinitions = toolDefinitions;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs;
    this.totalTimeoutMs = options.totalTimeoutMs;
    this.taskClassifier = options.taskClassifier;
    this.onActivateTools = options.onActivateTools;
    this.workflowCoordinator = options.workflowCoordinator;
    this.onTasksChange = options.onTasksChange;
    this.compaction = createCompactionGovernor(
      options.requestContinuation,
      systemPrompt,
      toolDefinitions,
    );
    this.modelFamilyPolicy =
      options.modelFamilyPolicy ?? resolveModelFamilyPolicy({ providerName: "" });
    this.retryPolicy = options.retryPolicy ?? createCorbitsRetryPolicy();
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
    return this.tasks.filter((t) => t.status === "todo" || t.status === "doing").map((t) => t.id);
  }

  private logTerminationWithOpenTasks(path: string): void {
    logger.error("Director reached a terminal decision on {path} with open tasks: {openTasks}", {
      path,
      openTasks: this.openTaskIds(),
    });
  }

  /**
   * Rewrites the infer action in a fall-through batch once pending tool
   * calls have resolved: pause wins over either still-armed nudge, and each
   * rewrite is one-shot — cleared as soon as it is actually applied to an
   * infer. The pause has two independent triggers, checked in order: the
   * fast path is tool-fingerprint period detection
   * (detectToolFingerprintThrash) — a repeating cycle (identical calls, or
   * an alternating/rotating pattern) can and often does trip the pause well
   * before the streak reaches toolOnlyTurnNudgeAt, so the check-in nudge is
   * not a precondition for the pause. The backstop
   * (detectTurnsSinceUserMessageBackstop) never pauses on its own the first
   * time it fires — it only nudges, asking for a progress summary; it only
   * escalates to a pause (toolOnlyPauseReason === "backstop") once that
   * nudge has gone unheeded for a further full interval with still no user
   * message and no period-detected thrash (see the escalation check in
   * decideInner).
   */
  private applyToolOnlyLoopProtection(
    actions: ReactorAction[],
    capabilities: ReactorCapabilities,
  ): ReactorAction[] | null {
    if (!this.pausedForToolOnly && !this.pendingToolOnlyNudge && !this.pendingBackstopNudge) {
      return null;
    }
    const inferIndex = actions.findIndex((a) => a.type === "infer");
    if (inferIndex === -1) return null;

    if (this.pausedForToolOnly) {
      const check = this.lastThrashCheck;
      const pauseMessage =
        this.toolOnlyPauseReason === "backstop"
          ? `Auto-paused: went ${this.turnsSinceUserMessage} turns without a message from the operator, and a progress-summary nudge went unanswered for a further ${TURNS_SINCE_USER_MESSAGE_BACKSTOP} turns. Send a message to resume.`
          : (() => {
              const detail =
                check !== null && check.period === 1
                  ? `repeated the same tool call ${check.repeats} times in a row`
                  : check !== null && check.period !== null
                    ? `repeated a ${check.period}-call cycle ${check.repeats} times in a row`
                    : "repeated tool calls in a cycle";
              return `Auto-paused: the model ${detail} without making progress. Send a message to resume.`;
            })();
      return [capabilities.checkpoint("tool-only-loop-paused"), capabilities.reply(pauseMessage)];
    }

    if (this.pendingBackstopNudge) {
      this.pendingBackstopNudge = false;
      const rewritten = [...actions];
      const existing = actions[inferIndex] as Extract<ReactorAction, { type: "infer" }>;
      rewritten[inferIndex] = inferWithNudge(capabilities, BACKSTOP_NUDGE_TEXT, existing.options);
      return rewritten;
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

  /**
   * One-shot salvage nudge after a worker hard-block. Fingerprint thrash
   * (applyToolOnlyLoopProtection) wins when both apply. Attaches to the infer
   * after pending tools have executed.
   */
  private applySalvageNudge(
    actions: ReactorAction[],
    capabilities: ReactorCapabilities,
  ): ReactorAction[] | null {
    if (this.pendingSalvageNudge === null) return null;
    const inferIndex = actions.findIndex((a) => a.type === "infer");
    if (inferIndex === -1) return null;
    const text = this.pendingSalvageNudge;
    this.pendingSalvageNudge = null;
    const rewritten = [...actions];
    const existing = actions[inferIndex] as Extract<ReactorAction, { type: "infer" }>;
    rewritten[inferIndex] = inferWithNudge(capabilities, text, existing.options);
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

    const directive = active ? (this.workflowCoordinator?.directive() ?? null) : null;

    const rewrite = (action: ReactorAction): ReactorAction => {
      if (action.type !== "infer") return action;
      const options = {
        ...action.options,
        tools,
        retryPolicy: action.options?.retryPolicy ?? this.retryPolicy,
      };
      if (this.inactivityTimeoutMs !== undefined)
        options.inactivityTimeoutMs = this.inactivityTimeoutMs;
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
    const afterCompact = this.compaction.resumeAfterCompact(event);
    if (afterCompact !== null) {
      // Compacted history is the live occupancy until the next provider-
      // reported inference.done; paint from the estimate in the meantime.
      this.compaction.notePostCompact(state.turns ?? []);
      // Idle empty compact only needed the decide re-entry to sync the meter;
      // stay idle rather than starting an unprompted inference.
      if (afterCompact === "meter") return capabilities.wait();
      return capabilities.infer();
    }
    const idleCompact = this.compaction.interceptIdleContinuation(event, capabilities);
    if (idleCompact !== null) return idleCompact;
    const recovery = this.compaction.interceptOverflow(event, capabilities);
    if (recovery !== null) return recovery;

    // Only `aborted` (internal-recovery-abort) lands here: the harness's own
    // retry policy already owns `timeout`/`retryable`/`quota_exhausted` and
    // has exhausted its own attempt budget (up to MAX_ATTEMPTS full-context
    // sends, see vendor/intx-inference/src/retry-policy.ts) before an
    // `inference.error` of one of those categories ever reaches the
    // director. Re-wrapping an already-exhausted harness retry in another
    // `capabilities.infer()` call multiplied the two budgets instead of
    // composing them (up to 9 identical full-context sends per turn,
    // CL-6910) without recovering anything the harness had not already
    // tried. Internal-recovery-abort is different: the harness's default
    // policy never retries `aborted` at all, so this remains the only
    // layer that owns that category, and it does not compound with the
    // harness's own attempts.
    if (
      event.type === "inference.error" &&
      event.error.category === "aborted" &&
      isInternalRecoveryAbort(event)
    ) {
      if (this.inferenceRecoveries < MAX_INFERENCE_RECOVERIES) {
        this.inferenceRecoveries++;
        logger.warn`inference-recovery attempt=${String(this.inferenceRecoveries)} max=${String(MAX_INFERENCE_RECOVERIES)} category=${event.error.category}`;
        return [capabilities.checkpoint("inference-recovery"), capabilities.infer()];
      }
      logger.warn`inference-recovery-exhausted max=${String(MAX_INFERENCE_RECOVERIES)} category=${event.error.category}`;
      return [
        capabilities.checkpoint("inference-recovery-exhausted"),
        capabilities.reply("The request could not recover. Send a message to resume."),
      ];
    }

    // The vendored DefaultDirector's inference.error preamble map
    // (vendor/intx-inference/src/default-director.ts, ERROR_PREAMBLE) has no
    // `timeout` entry, so it falls back to the `fatal` wording ("...
    // unrecoverable inference error"). Before CL-6910, a `timeout` reaching
    // the director was rare (the harness retried it first, then the director
    // recovered it again — see the block above), so operators almost never
    // saw that fallback text. Now an exhausted `timeout` routinely lands here
    // as a terminal reply, so the misleading "unrecoverable" wording would
    // become the routine message for an ordinary timeout. Intercept it here
    // with accurate, calm wording rather than patching the vendored map.
    if (event.type === "inference.error" && event.error.category === "timeout") {
      return [
        capabilities.checkpoint("inference-error"),
        capabilities.reply(
          "This agent's request timed out because the inference provider did not respond in time. The request was retried and gave up.",
        ),
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
      this.toolFingerprintHistory = [];
      this.lastThrashCheck = null;
      this.toolOnlyPauseReason = null;
      // Only a message carrying OPERATOR_ORIGINATED_FLAG resets the
      // backstop — not every message.received. Synthetic system sends
      // (compaction continuations, retries, future director continuations)
      // also fire message.received but never set this flag, so they cannot
      // buy back backstop budget (round-5 fix: round 4 reset on any
      // message.received, which synthetic compaction continuations satisfy
      // just as easily as a real operator message — see
      // turnsSinceUserMessage's declaration for the full history).
      if (isOperatorOriginated(event.message.flags)) {
        this.turnsSinceUserMessage = 0;
        this.backstopNudgeFiredAtTurn = null;
        this.pendingBackstopNudge = false;
        this.leafProgressBackstopResets = 0;
        this.salvageNudgeFired = false;
        this.pendingSalvageNudge = null;
        this.pendingTaskCallIds.clear();
      }
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

          const envelope =
            this.lastTaskSummary !== undefined
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

      // Main-session loop protection tracks two separate questions with two
      // separate reset rules:
      //  - "is the model cycling?" — toolFingerprintHistory / lastThrashCheck
      //    / toolOnlyStreak. Narration is legitimate evidence the model is
      //    not stuck in a tight loop, so any turn with text clears these
      //    (same as a fresh user message). A long raw toolOnlyStreak alone
      //    (toolOnlyTurnNudgeAt) is just a check-in nudge; the hard pause
      //    from this side requires an actual repeating cycle —
      //    detectToolFingerprintThrash runs exact-period detection (see
      //    util/period-detection.ts) over the rolling fingerprint history,
      //    catching not just identical-every-turn thrash but also
      //    alternating/rotating cycles (A,B,A,B,...; A,B,C,A,B,C,...).
      //  - "how long since the operator last saw a real checkpoint?" —
      //    turnsSinceUserMessage / backstopNudgeFiredAtTurn. Model-emitted
      //    text does NOT clear this, and neither does a system-originated
      //    message.received (e.g. a compaction continuation) — only a
      //    message carrying OPERATOR_ORIGINATED_FLAG does (see
      //    turnsSinceUserMessage's declaration for why: narration and
      //    synthetic sends must not be able to buy back backstop budget).
      // A dismissed ask_operator counts toward both like any other tool-only
      // turn (handled separately below; declined-tool early returns do not
      // reset the cycle-detection side because only text turns and fresh
      // messages do).
      this.turnsSinceUserMessage++;
      const turnContent = event.turn.content as readonly {
        type: string;
        name?: string;
        id?: string;
      }[];
      for (const block of turnContent) {
        if (block.type === "tool_call" && block.name === "task" && typeof block.id === "string") {
          this.pendingTaskCallIds.add(block.id);
        }
      }
      if (hasToolCalls && !hasText) {
        this.toolOnlyStreak++;
        const fingerprint = fingerprintToolCalls(event.turn.content);
        if (fingerprint !== null) {
          this.toolFingerprintHistory.push(fingerprint);
          if (this.toolFingerprintHistory.length > TOOL_FINGERPRINT_HISTORY_CAP) {
            this.toolFingerprintHistory.shift();
          }
        }
        this.lastThrashCheck = detectToolFingerprintThrash(this.toolFingerprintHistory);
      } else {
        this.toolOnlyStreak = 0;
        this.toolOnlyNudgeFired = false;
        this.pendingToolOnlyNudge = false;
        this.toolFingerprintHistory = [];
        this.lastThrashCheck = null;
      }

      // Recomputed fresh every turn boundary; whichever branch below fires
      // (if any) is this turn's outcome, in priority order:
      //  1. thrash (period detection) — fast path, always wins, hard pause.
      //  2. backstop escalation — the backstop nudge already fired and a
      //     further full backstop interval has elapsed with still no user
      //     message and no thrash detected — hard pause. This is the one
      //     case the backstop itself pauses on: a model that ignores a
      //     direct request for a progress summary is a real no-progress
      //     signal, unlike mere silence during a long autonomous stretch.
      //  3. backstop nudge — first time turnsSinceUserMessage reaches the
      //     threshold, ask for a progress summary. Does not pause.
      //  4. check-in nudge — the older, softer nudge on the raw
      //     narration-sensitive tool-only streak, unrelated to the backstop.
      this.pausedForToolOnly = false;
      this.toolOnlyPauseReason = null;
      if (this.lastThrashCheck?.repeating === true) {
        this.pausedForToolOnly = true;
        this.toolOnlyPauseReason = "thrash";
      } else if (
        this.backstopNudgeFiredAtTurn !== null &&
        this.turnsSinceUserMessage - this.backstopNudgeFiredAtTurn >=
          TURNS_SINCE_USER_MESSAGE_BACKSTOP
      ) {
        this.pausedForToolOnly = true;
        this.toolOnlyPauseReason = "backstop";
      } else if (
        this.backstopNudgeFiredAtTurn === null &&
        detectTurnsSinceUserMessageBackstop(this.turnsSinceUserMessage)
      ) {
        this.backstopNudgeFiredAtTurn = this.turnsSinceUserMessage;
        this.pendingBackstopNudge = true;
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

    if (event.type === "tool.done" && this.pendingTaskCallIds.has(event.result.callId)) {
      this.pendingTaskCallIds.delete(event.result.callId);
      const detail = event.result.detail as { stopReason?: ForcedStopReason } | undefined;
      const salvage = classifyBriefSalvage({
        ...(detail?.stopReason !== undefined ? { stopReason: detail.stopReason } : {}),
        wasCancelled: false,
      });
      if (salvage !== null && isHardBlockSalvage(salvage) && !this.salvageNudgeFired) {
        this.salvageNudgeFired = true;
        this.pendingSalvageNudge = PRIMARY_SALVAGE_NUDGE;
      }
      // CL-5893: a parent productively blocked on long-running task calls
      // racks up turnsSinceUserMessage one tool.done->infer cycle at a time
      // per leaf, and could hard-pause on fleet-heavy work despite never
      // actually stalling. A successful leaf completion — no tool error, and
      // no salvage class at all (not even a soft one like turn-budget or
      // deadline) — is real progress the operator will see reflected in the
      // transcript, so it re-arms the backstop interval exactly like a fresh
      // operator message would, without being treated as one: it does not
      // touch toolOnlyStreak/toolFingerprintHistory (those track cycling,
      // which a completed task says nothing about) or salvageNudgeFired.
      // True no-progress (tool-only churn with no successful leaf completions)
      // still nudges then pauses exactly as before.
      //
      // Bounded (round 2): this reset is capped at
      // MAX_LEAF_PROGRESS_BACKSTOP_RESETS per operator message so an
      // unbroken loop of trivial always-succeeding leaf tasks cannot reset
      // the backstop forever — once the cap is exhausted, leaf successes
      // stop resetting the interval and the nudge/pause escalation
      // eventually forces an operator checkpoint. Credit also requires the
      // tool result content to actually be a string, independent of the
      // structured salvage classification above.
      if (
        !event.result.isError &&
        salvage === null &&
        typeof event.result.content === "string" &&
        this.leafProgressBackstopResets < MAX_LEAF_PROGRESS_BACKSTOP_RESETS
      ) {
        this.turnsSinceUserMessage = 0;
        this.backstopNudgeFiredAtTurn = null;
        this.pendingBackstopNudge = false;
        this.leafProgressBackstopResets++;
      }
    }

    if (event.type === "tool.done" && this.workflowCalls.has(event.result.callId)) {
      const call = this.workflowCalls.get(event.result.callId);
      this.workflowCalls.delete(event.result.callId);
      const advanced = this.workflowCoordinator?.handleToolDone(
        call?.name,
        call?.args,
        event.result.isError === true,
      );
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
    const lookRewrite = this.applySalvageNudge(baseActions, capabilities);
    if (lookRewrite !== null) return lookRewrite;

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
        const nudge =
          "\n\nYou have not yet called advance_workflow. " +
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
    const atWorkflowGate = coordinator?.isActive() === true && coordinator.currentStepIsGate();
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
          const nudge =
            coordinator?.isActive() === true ? WORKFLOW_OPEN_TASK_NUDGE : IDLE_OPEN_TASK_NUDGE;
          return [...passThrough, inferWithNudge(capabilities, nudge)];
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
  const { provider, getProviderId, retryPolicy, ...rest } = options;
  return new ChatDirectorImpl(systemPrompt, toolDefinitions, {
    ...rest,
    // `provider` is raw {providerName, model} input; the constructor wants
    // the resolved ModelFamilyPolicy, not the input it was resolved from.
    modelFamilyPolicy: provider !== undefined ? resolveModelFamilyPolicy(provider) : undefined,
    // Stamp provider id onto retry errors so known-xAI short 429s remap.
    // Prefer an explicit policy, then a live getter (mid-session `/model`),
    // then the bootstrap providerName.
    retryPolicy:
      retryPolicy ??
      createCorbitsRetryPolicy(
        getProviderId !== undefined
          ? { providerId: getProviderId }
          : provider !== undefined
            ? { providerId: provider.providerName }
            : undefined,
      ),
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
