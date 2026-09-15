import {
  DefaultDirector,
  type ExtendedInferenceOptions,
} from "@intx/inference";
import { createHash } from "node:crypto";
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
import {
  type SessionMetadata,
  type TaskBoundary,
  isCompactSpacerEchoTurn,
} from "../session/compactor.js";
import type { WorkflowCoordinator } from "../workflows/coordinator.js";
import {
  compactionContinuationAction,
  createCompactionGovernor,
  type CompactionGovernor,
} from "./compaction.js";
import { onTurnBoundary } from "./reactor-events.js";
import { type } from "arktype";
import {
  applyManageTasks,
  hasActiveTasks,
  parseManageTasksArgs,
  TaskSchema,
  type Task,
} from "./tasks.js";
import { createCorbitsRetryPolicy } from "./retry-policy.js";
import { isInternalRecoveryAbortRaw } from "../inference-abort.js";
import { LOG_NAMESPACE_ROOT } from "../branding.js";
import {
  resolveModelFamilyPolicy,
  type ModelFamilyPolicy,
} from "./model-family-policy.js";
import { PRESENT_VIEW_PRIMITIVES_GUIDANCE } from "./tool-schema-normalize.js";
import {
  APPROVER_REJECTION_MARKER,
  DENIED_BY_POLICY_MARKER,
  NO_MATCHING_GRANTS_MARKER,
  OPERATOR_DECLINED_MARKER,
} from "../permission/decline-markers.js";

const logger = getLogger([LOG_NAMESPACE_ROOT, "agent", "director"]);

// The serialized `tools` array is the head of the provider's cached prompt
// prefix, ahead of the system prompt. Measured on OpenCode Go Responses, a warm
// session holds 99.3% cached and ANY change to that array — a mount, a
// description edit, or a pure reorder of an unchanged set — drops the next turn
// to 2-4%. Appending at the end is not cheaper than prepending: 4.5% versus
// 2.1%, both full misses.
//
// `advertisedTools` (src/agent/tool-search.ts) already keeps this array
// deterministic, so the array should only ever change when a genuine discovery
// grows it. This digest is here to prove that, because prefix churn is
// otherwise invisible — it shows up only as a billing and latency spike a turn
// later. Hashed rather than logged verbatim: MCP tool descriptions are
// arbitrary-length, server-supplied text and do not belong in the log stream.
export function toolSetDigest(tools: readonly ToolDefinition[]): string {
  const shape = tools
    .map(
      (t) =>
        `${t.name}:${t.description ?? ""}:${JSON.stringify(t.inputSchema ?? null)}`,
    )
    .join("|");
  return createHash("sha256").update(shape).digest("hex").slice(0, 12);
}

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
// Reply itself returns the reactor to waiting for the next inbound message, so
// it must replace the terminal wait rather than be paired with it. Empty reply
// content settles the connector without painting a transcript block.
//
// Assumes a terminal bare wait always means the turn is over. That holds for
// every current wait path: DefaultDirector in conversational mode (the only
// mode ChatDirector uses) yields one only on an empty model turn; exhausted
// spacer-echo incompleteness uses the same wait so loop-protection, workflow,
// and open-task rails can rewrite it to infer first. This helper only settles
// a leftover wait into an empty reply. The halt path already carries a reply;
// compaction, workflow, and open-task rewrites either keep those terminals or
// replace them with an infer. A future wait that pauses mid-turn while
// expecting more work must not be settled here.
function ensureCycleSettlesWithReply(
  actions: ReactorAction | ReactorAction[],
  capabilities: ReactorCapabilities,
): ReactorAction | ReactorAction[] {
  const list = Array.isArray(actions) ? actions : [actions];
  if (list.at(-1)?.type !== "wait") return actions;
  if (
    list.some(
      (a) =>
        a.type === "infer" || a.type === "execute_tools" || a.type === "reply",
    )
  ) {
    return actions;
  }
  return [...list.slice(0, -1), capabilities.reply("")];
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
const MAX_SPACER_ECHO_NUDGES = 2;

const SPACER_ECHO_NUDGE = "Continue the task. Do not repeat internal markers.";

const IDLE_OPEN_TASK_NUDGE =
  "\n\nYou are ending your turn while tasks are still open (todo/doing). " +
  "Finish the remaining work and mark each task done or cancelled with " +
  "manage_tasks before ending, or continue working with tools.";

const WORKFLOW_OPEN_TASK_NUDGE =
  "\n\nYou are ending your turn while tasks are still open (todo/doing) and a " +
  "workflow step is active. Continue working with tools, call submit_output " +
  "with this step's id once the step is complete, or mark finished tasks done " +
  "with manage_tasks. Do not end your turn with tasks still open.";

const DECLINED_OPEN_TASK_NUDGE =
  "\n\nThe operator declined the tool call. Do not retry the declined action. " +
  "Some tasks are still open (todo/doing): either take a different approach " +
  "that does not need the declined action, or mark those tasks cancelled with " +
  "manage_tasks. Do not end your turn with tasks still open.";

const PathArgSchema = type({ path: "string" });

export const askOperatorDefinition: ToolDefinition = {
  name: "ask_operator",
  description:
    "Pause execution and ask the operator a short clarifying question with short option labels. " +
    "Put any long rationale, trade-offs, or context in a normal transcript reply first, then call this " +
    "with only a brief question and brief option labels — the overlay is not a place for essays. " +
    "Each option label must be at most 48 characters. " +
    "Execution resumes when the operator selects an option.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "Short question shown in the overlay (one or two lines). Put long rationale in a transcript reply first.",
      },
      options: {
        type: "array",
        description:
          "Short option labels the operator can choose from (at most 48 characters each)",
        items: { type: "string", maxLength: 48 },
        minItems: 1,
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
            enum: [
              "default",
              "muted",
              "success",
              "warning",
              "danger",
              "accent",
            ],
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
              properties: {
                align: { type: "string", enum: ["left", "right", "center"] },
              },
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

export const submitOutputDefinition: ToolDefinition = {
  name: "submit_output",
  description:
    "Call this when the task is fully complete (include summary) or to complete " +
    "a workflow step (step id is required to advance; already-complete and " +
    "not-current step ids are acknowledged without advancing).",
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
          "Workflow step ID to complete. Required to advance a workflow. " +
          "Compared atomically against the current step.",
      },
    },
  },
};

// Classification of a failed tool call's model-facing text. Two flows produce
// these texts: the middleware path (permission-plugin prefixing the gate's
// "Operator declined: …" reason, still used by sub-agents) and the reactor
// path, where a rejected approval decision answers the parked call with
// upstream's "denied by approver…" error result and a deny/no-grant effect
// arrives as a block ("Denied by policy: …" / "No matching grants for …"). A
// policy deny is not an operator decision at all — the model adapts to the
// deny text as it would to any tool error — while an approver rejection
// either carries a reason the model should respond to or doesn't (canned
// reply stands). The marker strings themselves live in
// permission/decline-markers.ts alongside their producing seams.
type DeclinedToolResult =
  | { kind: "approver-rejection"; reason?: string }
  | { kind: "policy-deny" };

const POLICY_DENY_MARKERS = [
  DENIED_BY_POLICY_MARKER,
  NO_MATCHING_GRANTS_MARKER,
] as const;

function isPolicyDeny(content: string): boolean {
  return POLICY_DENY_MARKERS.some((marker) => content.includes(marker));
}

// The middleware path appends the operator's reason after an em-dash; the
// reactor path after "denied by approver: ". Both are undefined when the
// operator declined without a reason.
function approverRejectionReason(content: string): string | undefined {
  const reactor = content.match(
    new RegExp(`${APPROVER_REJECTION_MARKER}: (.+)`),
  );
  if (reactor !== null) return reactor[1];
  if (content.includes(OPERATOR_DECLINED_MARKER)) {
    const separator = content.indexOf(" — ");
    if (separator !== -1) return content.slice(separator + 3);
  }
  return undefined;
}

function classifyDeclinedToolResult(result: {
  content: unknown;
  isError?: boolean;
}): DeclinedToolResult | null {
  if (result.isError !== true || typeof result.content !== "string")
    return null;
  const content = result.content;
  if (isPolicyDeny(content)) return { kind: "policy-deny" };
  if (
    content.includes(APPROVER_REJECTION_MARKER) ||
    content.includes(OPERATOR_DECLINED_MARKER)
  ) {
    const reason = approverRejectionReason(content);
    return reason === undefined
      ? { kind: "approver-rejection" }
      : { kind: "approver-rejection", reason };
  }
  return null;
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
// update for tasks-changed event purposes.
function applyManageTasksToolCall(
  tasks: Task[],
  block: { name: string; arguments: unknown },
): Task[] | null {
  if (block.name !== "manage_tasks") return null;
  const taskArgs = parseManageTasksArgs(block.arguments);
  return taskArgs !== null ? applyManageTasks(tasks, taskArgs) : null;
}

// Reactor events the chat director emits in place of host closures. Hosts
// (TUI, exec) subscribe on the agent stream: task-list changes replace the
// former onTasksChange callback, tool activation replaces onActivateTools.
// Neither namespace collides with the reactor's reserved prefixes
// (inference., tool., reactor., fork.).
export const CHAT_TASKS_CHANGED_EVENT = "custom.chat.tasks.changed";
export const CHAT_TOOLS_ACTIVATE_EVENT = "custom.chat.tools.activate";
export const ChatTasksChangedDataSchema = type({
  tasks: TaskSchema.array(),
});
export const ChatToolsActivateDataSchema = type({
  names: "string[]",
});

export interface ChatDirectorOptions {
  taskClassifier?:
    | ((message: string, metadata: SessionMetadata) => Promise<TaskBoundary>)
    | undefined;
  inactivityTimeoutMs?: number | undefined;
  totalTimeoutMs?: number | undefined;
  workflowCoordinator?: WorkflowCoordinator | undefined;
  provider?: { providerName: string; model?: string } | undefined;
  /**
   * CL-7918 decisions (both former closures removed, no new env key):
   *
   * - getProviderId → reactor-supplied. The retry policy needs the *live*
   *   source id per retry so mid-session /model switches remap retry stamping
   *   (bare-429 xAI remap). A BaseEnv-derived id goes stale at the first
   *   switch and only refreshes on rebuild; a static config id can never
   *   remap. The reactor already learns the live id on every inference
   *   completion, so it tracks currentSourceId itself (seeded from the session
   *   providerName) and hands the policy a getter over it.
   *   Accepted residual gap: retries during the single inference that first
   *   uses a switched model still stamp the previous id — the director learns
   *   the new id from that inference's completion event.
   *
   * - getLiveFleetCount → seeded config + live narrow setter
   *   (setAllowIdleWithFleet below). The count is genuinely external (subagent
   *   lane statuses the reactor never sees — its own tasks only carry
   *   todo/doing/done/cancelled), so neither BaseEnv-derived nor
   *   reactor-supplied can reproduce its liveness. Idle-with-fleet itself is
   *   unchanged (fleet-running TUI sessions allow the terminal wait); the
   *   fleet-wake publisher drives the setter on count transitions, so a
   *   drained fleet resumes the open-task nudge.
   */
  /** Explicit retry policy; when set, skips the default Corbits policy. */
  retryPolicy?: RetryPolicy | undefined;
  /**
   * Initial idle-with-fleet allowance (CL-7918 replacement for the former
   * getLiveFleetCount closure). When true the director allows a terminal
   * wait/reply with open tasks; when omitted or false it keeps the open-task
   * nudge. The TUI seeds this (fleet lanes may appear mid-session); exec
   * omits it. The live fleet-wake publisher then keeps it current through
   * setAllowIdleWithFleet, so a drained fleet resumes the nudge.
   */
  allowIdleWithFleet?: boolean | undefined;
}

// The constructor takes the resolved ModelFamilyPolicy rather than the raw
// `provider` input the factory function accepts and resolves on its behalf.
type ChatDirectorImplOptions = Omit<ChatDirectorOptions, "provider"> & {
  modelFamilyPolicy?: ModelFamilyPolicy | undefined;
  /** Provider-stamped retry policy (xAI short 429 remapping needs providerId). */
  retryPolicy?: RetryPolicy | undefined;
  /** Session-construction providerName: seeds currentSourceId pre-completion. */
  sessionProviderName?: string | undefined;
};

class ChatDirectorImpl extends DefaultDirector {
  private readonly workflowCalls = new Map<
    string,
    { name: string; args: unknown }
  >();
  private readonly lspTriggerCalls = new Set<string>();
  private readonly askOperatorCalls = new Set<string>();
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
  private spacerEchoNudges = 0;
  private lastInferenceTurnHadContent = false;
  private operatorJustResponded = false;
  private tasks: Task[] = [];
  private turnCount = 0;
  private currentTaskLabel: string | undefined;
  private lastTaskSummary: string | undefined;
  private startedAt = Date.now();
  private readonly compaction: CompactionGovernor;
  private readonly modelFamilyPolicy: ModelFamilyPolicy;
  private readonly retryPolicy: RetryPolicy;
  // CL-7918: reactor-supplied live source id for retry stamping (replaces the
  // former getProviderId closure). Seeded from the session providerName and
  // refreshed on every inference completion, so mid-session /model switches
  // remap without rebuilding the agent.
  private currentSourceId: string | undefined;
  /** CL-7918 live replacement for the former getLiveFleetCount closure. */
  private allowIdleWithFleet: boolean;
  // Consecutive assistant turns that contain tool calls and no text. Reset on
  // any turn with text and on every fresh user message — a weak model that
  // spins in place on one thread of tool calls still converges to the
  // check-in nudge, regardless of what it calls in between (same reset
  // discipline as the idle/declined nudge budgets above). Drives the soft
  // check-in nudge at toolOnlyTurnNudgeAt (see applyToolOnlyLoopProtection) —
  // a turn-count nudge, not a stop.
  private toolOnlyStreak = 0;
  private toolOnlyNudgeFired = false;
  private pendingToolOnlyNudge = false;
  // Reactor events queued while scanning the current inbound event. Drained
  // in decide() and appended to whatever the turn returns, so task/tool
  // notifications ride along with every terminal action list (emit is
  // composable with all other actions).
  private pendingEmits: ReactorAction[] = [];

  constructor(
    systemPrompt: string,
    toolDefinitions: ToolDefinition[],
    options: ChatDirectorImplOptions,
  ) {
    // Compose before super(). The base director keeps its own copy of the
    // system prompt and sets options.systemPrompt from it on every ordinary
    // turn, so withCurrentTools' `?? this._systemPrompt` fallback never fires
    // and anything appended after super() is built but never sent.
    const familyPolicy =
      options.modelFamilyPolicy ??
      resolveModelFamilyPolicy({ providerName: "" });
    const disciplineRules = familyPolicy.toolDisciplineRules;
    // Family tool-discipline rules go at the tail. Appending there is
    // prefix-safe: measured on OpenCode Go Responses, tail appends hold a
    // 99.1% cache hit while an edit at the head drops it to 9%.
    const composedPrompt =
      disciplineRules !== undefined && disciplineRules.length > 0
        ? `${systemPrompt}\n\n${disciplineRules}`
        : systemPrompt;
    super(composedPrompt, toolDefinitions, {});
    this._systemPrompt = composedPrompt;
    this._toolDefinitions = toolDefinitions;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs;
    this.totalTimeoutMs = options.totalTimeoutMs;
    this.taskClassifier = options.taskClassifier;
    this.workflowCoordinator = options.workflowCoordinator;
    // The chat path holds no continuation closure: the governor expresses
    // continuation as an emit action the host answers with a deliver.
    this.compaction = createCompactionGovernor(
      undefined,
      composedPrompt,
      toolDefinitions,
    );
    this.modelFamilyPolicy = familyPolicy;
    // CL-7918: the default policy stamps the live source id per retry decision
    // via a getter over currentSourceId (seeded from the session provider,
    // refreshed on each inference completion) — no host closure needed. An
    // explicit policy still skips this entirely.
    this.currentSourceId = options.sessionProviderName;
    this.retryPolicy =
      options.retryPolicy ??
      createCorbitsRetryPolicy({ providerId: () => this.currentSourceId });
    this.allowIdleWithFleet = options.allowIdleWithFleet === true;
  }

  setWorkflowCoordinator(coordinator: WorkflowCoordinator | undefined): void {
    this.workflowCoordinator = coordinator;
  }

  // Narrow live setter for the idle-with-fleet allowance (CL-7972): the
  // fleet-wake publisher drives this on fleet-count transitions, so a drained
  // fleet resumes the open-task nudge instead of holding the seeded value.
  setAllowIdleWithFleet(value: boolean): void {
    this.allowIdleWithFleet = value;
  }

  updateToolDefinitions(toolDefinitions: ToolDefinition[]): void {
    const before = toolSetDigest(this._toolDefinitions);
    const after = toolSetDigest(toolDefinitions);
    this._toolDefinitions = toolDefinitions;
    if (before === after) return;
    logger.debug`tool-set-changed count=${String(this._toolDefinitions.length)} before=${before} after=${after}`;
  }

  getTasks(): Task[] {
    return [...this.tasks];
  }

  // A resumed session's task list lives in the transcript, not in the freshly
  // constructed director. Without this the chrome panel would read an empty
  // list until the model happened to call manage_tasks again, disagreeing
  // with the task block already painted in the transcript. The host emits
  // the tasks-changed reactor event after calling this (the director cannot
  // emit outside decide()).
  restoreTasks(tasks: Task[]): void {
    this.tasks = [...tasks];
  }

  // The status bar's context meter falls back to this when a provider omits
  // or zeroes usage on the latest turn — a local lower-then-corrected bound
  // beats displaying a number the provider never actually reported.
  getContextEstimate(): { tokens: number; isEstimate: boolean } {
    return {
      tokens: this.compaction.estimatedTokens,
      isEstimate: this.compaction.usingEstimate,
    };
  }

  private openTaskIds(): string[] {
    return this.tasks
      .filter((t) => t.status === "todo" || t.status === "doing")
      .map((t) => t.id);
  }

  private logTerminationWithOpenTasks(path: string): void {
    logger.error(
      "Director reached a terminal decision on {path} with open tasks: {openTasks}",
      {
        path,
        openTasks: this.openTaskIds(),
      },
    );
  }

  /**
   * Rewrites the infer action in a fall-through batch once pending tool
   * calls have resolved, attaching the soft check-in nudge once the raw
   * tool-only streak reaches toolOnlyTurnNudgeAt. A turn-count nudge, not a
   * stop — the session keeps running either way.
   */
  private applyToolOnlyLoopProtection(
    actions: ReactorAction[],
    capabilities: ReactorCapabilities,
  ): ReactorAction[] | null {
    if (!this.pendingToolOnlyNudge) {
      return null;
    }
    const inferIndex = actions.findIndex((a) => a.type === "infer");
    if (inferIndex === -1) return null;

    this.pendingToolOnlyNudge = false;
    const rewritten = [...actions];
    const existing = actions[inferIndex] as Extract<
      ReactorAction,
      { type: "infer" }
    >;
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
    // submit_output rides on the wire every turn, workflow or not, so
    // activating a workflow never grows the tools array and busts the cache
    // prefix. Outside a workflow it is a harmless no-op the director ignores
    // unless the call is a terminal task submission.
    const tools = this._toolDefinitions.some(
      (t) => t.name === submitOutputDefinition.name,
    )
      ? this._toolDefinitions
      : [...this._toolDefinitions, submitOutputDefinition];

    const directive = active
      ? (this.workflowCoordinator?.directive() ?? null)
      : null;

    const rewrite = (action: ReactorAction): ReactorAction => {
      if (action.type !== "infer") return action;
      const options = {
        ...action.options,
        tools,
        retryPolicy: action.options?.retryPolicy ?? this.retryPolicy,
        systemPrompt: action.options?.systemPrompt ?? this._systemPrompt,
      };
      if (this.inactivityTimeoutMs !== undefined)
        options.inactivityTimeoutMs = this.inactivityTimeoutMs;
      if (this.totalTimeoutMs !== undefined)
        options.totalTimeoutMs = this.totalTimeoutMs;
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
    try {
      const settled = ensureCycleSettlesWithReply(
        await this.decideInner(event, state, capabilities),
        capabilities,
      );
      const withTools = this.withCurrentTools(settled);
      if (this.pendingEmits.length === 0) return withTools;
      const emits = this.pendingEmits;
      this.pendingEmits = [];
      return [
        ...(Array.isArray(withTools) ? withTools : [withTools]),
        ...emits,
      ];
    } catch (err) {
      // A failed turn must not leak its queued task/tool notifications into
      // the next turn — drop them so the next turn starts clean instead of
      // flushing stale updates.
      this.pendingEmits = [];
      throw err;
    }
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
    const idleCompact = this.compaction.interceptIdleContinuation(
      event,
      capabilities,
    );
    if (idleCompact !== null) return idleCompact;
    const recovery = this.compaction.interceptOverflow(event, capabilities);
    if (recovery !== null) return recovery;

    // A forged or replayed compaction continuation arrives as an empty
    // message.received with no outstanding compact state (the legit resume
    // is consumed above). Answering it with infer would burn a billable
    // model turn and reset the loop-protection budgets below, so hold the
    // loop instead.
    if (event.type === "message.received") {
      const content =
        typeof event.message.content === "string" ? event.message.content : "";
      if (
        content.length === 0 &&
        !this.compaction.hasOutstandingContinuation()
      ) {
        return capabilities.wait();
      }
    }

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
        return [
          capabilities.checkpoint("inference-recovery"),
          capabilities.infer(),
        ];
      }
      logger.warn`inference-recovery-exhausted max=${String(MAX_INFERENCE_RECOVERIES)} category=${event.error.category}`;
      return [
        capabilities.checkpoint("inference-recovery-exhausted"),
        capabilities.reply(
          "The request could not recover. Send a message to resume.",
        ),
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
    if (
      event.type === "inference.error" &&
      event.error.category === "timeout"
    ) {
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
      this.spacerEchoNudges = 0;
      this.toolOnlyStreak = 0;
      this.toolOnlyNudgeFired = false;
      this.pendingToolOnlyNudge = false;
    }
    if (onTurnBoundary(event)) this.inferenceRecoveries = 0;

    if (
      event.type === "message.received" &&
      this.taskClassifier !== undefined
    ) {
      const message = event.message;
      const content =
        typeof message.content === "string" ? message.content : "";
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
      const hasToolCalls = event.turn.content.some(
        (b) => b.type === "tool_call",
      );
      const hasText =
        event.turn.content.some(
          (b) =>
            b.type === "text" &&
            typeof b.text === "string" &&
            b.text.length > 0,
        ) && !isCompactSpacerEchoTurn(event.turn);
      this.lastInferenceTurnHadContent = hasToolCalls || hasText;

      // toolOnlyStreak is narration-sensitive: any turn with text clears it
      // (same as a fresh user message), and it only drives the soft
      // check-in nudge at toolOnlyTurnNudgeAt, never a stop.
      if (hasToolCalls && !hasText) {
        this.toolOnlyStreak++;
      } else {
        this.toolOnlyStreak = 0;
        this.toolOnlyNudgeFired = false;
        this.pendingToolOnlyNudge = false;
      }

      if (
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
          // Echo-nudge cycles are incompleteness, not a contentful idle beat.
          // Count them only after the echo budget is spent so the step-nudge
          // rail still has its three turns before the stuck reply.
          const spacerEchoStillNudging =
            isCompactSpacerEchoTurn(event.turn) &&
            this.spacerEchoNudges < MAX_SPACER_ECHO_NUDGES;
          if (!spacerEchoStillNudging) this.workflowIdleTurns++;
        }
      }
      for (const block of event.turn.content) {
        if (block.type !== "tool_call") continue;
        if (block.name === "manage_tasks") {
          const next = applyManageTasksToolCall(this.tasks, block);
          if (next !== null) {
            this.tasks = next;
            this.pendingEmits.push(
              capabilities.emit(CHAT_TASKS_CHANGED_EVENT, {
                tasks: this.tasks,
              }),
            );
          }
        } else if (block.name === "read_file" || block.name === "edit_file") {
          const pathResult = PathArgSchema(block.arguments);
          const path = pathResult instanceof type.errors ? "" : pathResult.path;
          if (isCodeFile(path)) this.lspTriggerCalls.add(block.id);
        }
        if (block.name === "submit_output") {
          this.workflowCalls.set(block.id, {
            name: block.name,
            args: block.arguments,
          });
        }
        if (block.name === "ask_operator") {
          this.askOperatorCalls.add(block.id);
        }
      }
    }

    if (
      event.type === "tool.done" &&
      this.workflowCalls.has(event.result.callId)
    ) {
      const call = this.workflowCalls.get(event.result.callId);
      this.workflowCalls.delete(event.result.callId);
      const advanced = this.workflowCoordinator?.handleToolDone(
        call?.name,
        call?.args,
        event.result.isError === true,
      );
      if (advanced) this.workflowIdleTurns = 0;
    }

    if (
      event.type === "tool.done" &&
      this.askOperatorCalls.has(event.result.callId)
    ) {
      this.askOperatorCalls.delete(event.result.callId);
      if (!event.result.isError) {
        this.operatorJustResponded = true;
      }
    }

    if (
      event.type === "tool.done" &&
      this.lspTriggerCalls.has(event.result.callId)
    ) {
      this.lspTriggerCalls.delete(event.result.callId);
      if (!event.result.isError)
        this.pendingEmits.push(
          capabilities.emit(CHAT_TOOLS_ACTIVATE_EVENT, { names: ["lsp"] }),
        );
    }

    if (event.type === "tool.done") {
      const declined = classifyDeclinedToolResult(event.result);
      // Reason-less approver rejections are the only canned case: the model
      // has no reason to respond to. Reason-bearing approver rejections and
      // policy denies re-infer below — the model responds to the reason or
      // adapts to the deny text.
      if (
        declined !== null &&
        declined.kind === "approver-rejection" &&
        declined.reason === undefined
      ) {
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
    }

    // Keep the running local estimate current on every cycle (tool results and
    // rewrites included). Arming still happens inside noteInferenceDone, which
    // prefers provider usage when present.
    const turns = state.turns ?? [];
    this.compaction.syncFromTurns(turns);
    // CL-7918: reactor-supplied live source id (replaces getProviderId). The
    // completion stamps the source that served it, so a mid-session /model
    // switch remaps retry stamping from the next completion on; the harness's
    // lastCycleSource is the call-start snapshot and wins on conflict.
    if (event.type === "inference.done") {
      const served = event.source?.sourceId;
      if (served !== undefined && served !== "") this.currentSourceId = served;
    }
    const cycled = state.lastCycleSource?.sourceId;
    if (cycled !== undefined && cycled !== "") this.currentSourceId = cycled;
    if (onTurnBoundary(event)) {
      this.compaction.noteInferenceDone(event, turns);
    }

    if (
      event.type === "inference.done" &&
      isCompactSpacerEchoTurn(event.turn)
    ) {
      if (this.spacerEchoNudges < MAX_SPACER_ECHO_NUDGES) {
        this.spacerEchoNudges++;
        return inferWithNudge(capabilities, SPACER_ECHO_NUDGE);
      }
    }

    const base = await super.decide(event, state, capabilities);
    let baseActions = Array.isArray(base) ? base : [base];
    const spacerEchoExhausted =
      event.type === "inference.done" && isCompactSpacerEchoTurn(event.turn);
    if (spacerEchoExhausted) {
      baseActions = baseActions.map((a) =>
        a.type === "reply" ? capabilities.wait() : a,
      );
    }

    // Idle arming returns an emit action (continuation as a ReactorAction)
    // so the host re-enters the loop and the governor can compact on the
    // continuation's arrival.
    const idleContinuationArmed = this.compaction.noteIdleTurn(
      event,
      baseActions,
    );
    const compacted = this.compaction.interceptActions(
      event,
      baseActions,
      capabilities,
    );
    if (compacted !== null) return compacted;
    if (idleContinuationArmed)
      return [...baseActions, compactionContinuationAction(capabilities)];

    // Loop protection takes precedence over workflow/open-task
    // continuation nudges below: those exist to keep a session moving,
    // which is exactly the behavior the pause is guarding against. A tool
    // call turn (like the one that triggered this) must still execute
    // before any nudge or pause can land — a bare user turn on top of
    // pending tool_calls is a provider-invalid conversation — so this only
    // rewrites an `infer` action once pending tools have resolved and one
    // is actually present in the batch (mirrors the sub-agent report-forced
    // wiring in src/subagent/index.ts).
    const toolOnlyRewrite = this.applyToolOnlyLoopProtection(
      baseActions,
      capabilities,
    );
    if (toolOnlyRewrite !== null) return toolOnlyRewrite;

    const coordinator = this.workflowCoordinator;
    if (coordinator?.isActive() && !coordinator.currentStepIsGate()) {
      const hasTerminal = baseActions.some(
        (a) => a.type === "wait" || a.type === "reply",
      );
      if (
        hasTerminal &&
        (this.lastInferenceTurnHadContent || spacerEchoExhausted)
      ) {
        if (this.operatorJustResponded) {
          this.operatorJustResponded = false;
          return baseActions;
        }
        if (this.workflowIdleTurns >= 3) {
          if (hasActiveTasks(this.tasks))
            this.logTerminationWithOpenTasks("workflow-idle-stall");
          return [
            capabilities.reply(
              "The workflow appears stuck on this step. Send a message to continue or advance manually.",
            ),
          ];
        }
        const stepId = coordinator.currentStepId();
        const stepClause =
          stepId !== null
            ? `call submit_output with { "step": "${stepId}" } now`
            : "call submit_output with this step's id now";
        const nudge =
          `\n\nYou have not yet completed this workflow step. ` +
          `If this step is complete, ${stepClause}. ` +
          `Otherwise continue working with tools.`;
        const passThrough = baseActions.filter(
          (
            a,
          ): a is Exclude<
            ReactorAction,
            { type: "wait" } | { type: "reply" }
          > => a.type !== "wait" && a.type !== "reply",
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
      const hasTerminal = baseActions.some(
        (a) => a.type === "wait" || a.type === "reply",
      );
      if (hasTerminal) {
        // CL-7918 live idle-with-fleet allowance (replaces the former
        // getLiveFleetCount closure): seeded at construction, then kept
        // current by the fleet-wake publisher. TUI seeds true (fleet lanes
        // may appear mid-session); exec omits it and keeps the nudge.
        if (this.allowIdleWithFleet) {
          return base;
        }
        if (this.idleTerminationNudges < MAX_OPEN_TASK_NUDGES) {
          this.idleTerminationNudges++;
          const passThrough = baseActions.filter(
            (
              a,
            ): a is Exclude<
              ReactorAction,
              { type: "wait" } | { type: "reply" }
            > => a.type !== "wait" && a.type !== "reply",
          );
          // Inside a workflow the terminal action is submit_output with the
          // current step id, so point the nudge at it rather than the general
          // manage_tasks guidance.
          const nudge =
            coordinator?.isActive() === true
              ? WORKFLOW_OPEN_TASK_NUDGE
              : IDLE_OPEN_TASK_NUDGE;
          return [...passThrough, inferWithNudge(capabilities, nudge)];
        }
        this.logTerminationWithOpenTasks("idle-stall");
      }
    }

    return baseActions;
  }
}

export function createChatDirector(
  systemPrompt: string,
  toolDefinitions: ToolDefinition[],
  options: ChatDirectorOptions,
): ChatDirector {
  const { provider, retryPolicy, ...rest } = options;
  return new ChatDirectorImpl(systemPrompt, toolDefinitions, {
    ...rest,
    // `provider` is raw {providerName, model} input; the constructor wants
    // the resolved ModelFamilyPolicy, not the input it was resolved from.
    modelFamilyPolicy:
      provider !== undefined ? resolveModelFamilyPolicy(provider) : undefined,
    // CL-7918: seed the reactor-tracked live source id (replaces
    // getProviderId). The impl refreshes it on every inference completion so
    // mid-session `/model` switches remap retry stamping.
    sessionProviderName: provider?.providerName,
    // Stamp provider id onto retry errors so known-xAI short 429s remap.
    // Prefer an explicit policy; otherwise the impl builds the default policy
    // over its live source-id tracker.
    retryPolicy,
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
  setAllowIdleWithFleet(value: boolean): void;
  getTasks(): Task[];
  restoreTasks(tasks: Task[]): void;
  getContextEstimate(): { tokens: number; isEstimate: boolean };
}
