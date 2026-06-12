import { DefaultDirector } from "@intx/inference";
import type {
  ReactorDirector,
  ReactorInboundEvent,
  ReactorState,
  ReactorCapabilities,
  ReactorAction,
  ToolDefinition,
} from "@intx/types/runtime";
import type { DirectorPersistedState } from "./state.js";
import {
  type SessionMetadata,
  type TaskBoundary,
} from "./context-compactor.js";

export type PlanStep = {
  file: string;
  action: string;
  reason: string;
};

export const submitPlanDefinition: ToolDefinition = {
  name: "submit_plan",
  description:
    "Call this on your first turn to declare a structured plan for the task.",
  inputSchema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        description: "Ordered list of planned steps",
        items: {
          type: "object",
          properties: {
            file: { type: "string", description: "File this step touches" },
            action: { type: "string", description: "What to do with the file" },
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

export const submitOutputDefinition: ToolDefinition = {
  name: "submit_output",
  description:
    "Call this when the task is fully complete. Include a brief summary of what was done.",
  inputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Brief summary of the completed work",
      },
    },
    required: ["summary"],
  },
};

export interface CodingDirector extends ReactorDirector {
  getTurnsUsed(): number;
  getState(): DirectorPersistedState;
  setState(state: DirectorPersistedState): void;
  getFilesReadAtTurn(): ReadonlyMap<string, number>;
}


function isValidPlanArgs(args: unknown): args is { steps: PlanStep[] } {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (!Array.isArray(a.steps)) return false;
  for (const step of a.steps) {
    if (typeof step !== "object" || step === null) return false;
    const s = step as Record<string, unknown>;
    if (typeof s.file !== "string") return false;
    if (typeof s.action !== "string") return false;
    if (typeof s.reason !== "string") return false;
  }
  return true;
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
  // Tracks whether this director has already emitted done() so that any
  // stray events delivered after termination do not produce a second done().
  private terminated = false;

  constructor(
    systemPrompt: string,
    toolDefinitions: ToolDefinition[],
    initialState?: DirectorPersistedState,
    maxTurns?: number,
  ) {
    super(systemPrompt, toolDefinitions, {});
    this.maxTurns = maxTurns;
    if (initialState !== undefined) {
      this.setState(initialState);
    }
  }

  override async decide(
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

      for (const block of event.turn.content) {
        if (block.type === "tool_call") {
          this.callIdToName.set(block.id, block.name);
          this.callIdToArgs.set(block.id, block.arguments);
          if (block.name === "submit_plan") {
            if (isValidPlanArgs(block.arguments)) {
              this.plan = block.arguments.steps;
              this.planSubmitted = true;
            }
          }
        }
      }

      if (this.submitCalled) {
        if (!hasToolCalls) {
          return [
            capabilities.checkpoint("submit-accepted"),
            capabilities.reply("Task completed."),
          ];
        }
      }

      if (this.idleCycles >= 3) {
        this.terminated = true;
        return [
          capabilities.checkpoint("idle-abort"),
          capabilities.reply("Agent stalled: no tool calls for 3 turns."),
          capabilities.done(),
        ];
      }

    }

    if (event.type === "tool.done") {
      if (isOperatorDeclinedToolResult(event.result)) {
        return [
          capabilities.checkpoint("operator-declined"),
          capabilities.done(),
        ];
      }
      const name = this.callIdToName.get(event.result.callId);
      if (name === "submit_output" && isSuccessfulToolResult(event.result)) {
        this.submitCalled = true;
        if (!this.planSubmitted && this._turnsUsed - 1 > 3) {
          const base = await super.decide(event, state, capabilities);
          const baseActions = Array.isArray(base) ? base : [base];
          return [...baseActions, capabilities.reply("Warning: task completed without a plan. Consider calling submit_plan on turn 1 for multi-step tasks.")];
        }
      }
      if (name === "read_file" && !event.result.isError) {
        const args = this.callIdToArgs.get(event.result.callId);
        const path = typeof args === "object" && args !== null ? String((args as Record<string, unknown>).path ?? "") : "";
        if (path.length > 0) {
          this.filesReadAtTurn.set(path, this._turnsUsed);
        }
      }
    }

    return super.decide(event, state, capabilities);
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
): CodingDirector {
  return new CodingDirectorImpl(systemPrompt, toolDefinitions, initialState, maxTurns);
}

export type ApprovalGate = (plan: PlanStep[]) => Promise<boolean>;

class ChatDirectorImpl extends DefaultDirector {
  private readonly submitPlanArgs = new Map<string, unknown>();
  private readonly approvalGate: ApprovalGate;
  private readonly taskClassifier:
    | ((message: string, metadata: SessionMetadata) => Promise<TaskBoundary>)
    | undefined;
  private readonly _systemPrompt: string;
  private _toolDefinitions: ToolDefinition[];
  private turnCount = 0;
  private currentTaskLabel: string | undefined;
  private lastTaskSummary: string | undefined;
  private startedAt = Date.now();

  constructor(
    systemPrompt: string,
    toolDefinitions: ToolDefinition[],
    approvalGate: ApprovalGate,
    taskClassifier?: (message: string, metadata: SessionMetadata) => Promise<TaskBoundary>,
  ) {
    super(systemPrompt, toolDefinitions, {});
    this._systemPrompt = systemPrompt;
    this._toolDefinitions = toolDefinitions;
    this.approvalGate = approvalGate;
    this.taskClassifier = taskClassifier;
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
    const rewrite = (action: ReactorAction): ReactorAction =>
      action.type === "infer"
        ? { type: "infer", options: { ...action.options, tools: this._toolDefinitions } }
        : action;
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
      for (const block of event.turn.content) {
        if (block.type === "tool_call" && block.name === "submit_plan") {
          this.submitPlanArgs.set(block.id, block.arguments);
        }
      }
    }

    if (event.type === "tool.done" && this.submitPlanArgs.has(event.result.callId)) {
      const args = this.submitPlanArgs.get(event.result.callId);
      this.submitPlanArgs.delete(event.result.callId);
      if (!event.result.isError) {
        const plan = isValidPlanArgs(args) ? args.steps : [];
        const approved = await this.approvalGate(plan);
        if (!approved) {
          return capabilities.done();
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

    return super.decide(event, state, capabilities);
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
): ChatDirectorWithClear {
  if (approvalGate !== undefined) {
    return new ChatDirectorImpl(systemPrompt, toolDefinitions, approvalGate, taskClassifier);
  }
  return new ChatDirectorImpl(systemPrompt, toolDefinitions, async () => true, taskClassifier);
}

export interface ChatDirectorWithClear extends ReactorDirector {
  signalNewTask(summary?: string): void;
  updateToolDefinitions(toolDefinitions: ToolDefinition[]): void;
}
