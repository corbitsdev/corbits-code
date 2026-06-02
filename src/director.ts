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

class CodingDirectorImpl extends DefaultDirector implements CodingDirector {
  private submitCalled = false;
  private _turnsUsed = 0;
  private readonly callIdToName = new Map<string, string>();
  private readonly callIdToArgs = new Map<string, unknown>();
  private readonly filesReadAtTurn = new Map<string, number>();
  private idleCycles = 0;
  private planSubmitted = false;
  private plan: PlanStep[] = [];

  constructor(
    systemPrompt: string,
    toolDefinitions: ToolDefinition[],
    initialState?: DirectorPersistedState,
  ) {
    super(systemPrompt, toolDefinitions, {});
    if (initialState !== undefined) {
      this.setState(initialState);
    }
  }

  override async decide(
    event: ReactorInboundEvent,
    state: ReactorState,
    capabilities: ReactorCapabilities,
  ): Promise<ReactorAction | ReactorAction[]> {
    if (event.type === "inference.done") {
      this._turnsUsed++;

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
        return [
          capabilities.checkpoint("idle-abort"),
          capabilities.reply("Agent stalled: no tool calls for 3 turns."),
          capabilities.done(),
        ];
      }

    }

    if (event.type === "tool.done") {
      const name = this.callIdToName.get(event.result.callId);
      if (name === "submit_output" && !event.result.isError) {
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
): CodingDirector {
  return new CodingDirectorImpl(systemPrompt, toolDefinitions, initialState);
}

export type ApprovalGate = (plan: PlanStep[]) => Promise<boolean>;

class ChatDirectorImpl extends DefaultDirector {
  private readonly submitPlanArgs = new Map<string, unknown>();
  private readonly approvalGate: ApprovalGate;

  constructor(
    systemPrompt: string,
    toolDefinitions: ToolDefinition[],
    approvalGate: ApprovalGate,
  ) {
    super(systemPrompt, toolDefinitions, {});
    this.approvalGate = approvalGate;
  }

  override async decide(
    event: ReactorInboundEvent,
    state: ReactorState,
    capabilities: ReactorCapabilities,
  ): Promise<ReactorAction | ReactorAction[]> {
    if (event.type === "inference.done") {
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
          return [
            capabilities.reply("Plan rejected. Please revise the task and try again."),
            capabilities.done(),
          ];
        }
      }
    }

    return super.decide(event, state, capabilities);
  }
}

export function createChatDirector(
  systemPrompt: string,
  toolDefinitions: ToolDefinition[],
  approvalGate?: ApprovalGate,
): ReactorDirector {
  if (approvalGate !== undefined) {
    return new ChatDirectorImpl(systemPrompt, toolDefinitions, approvalGate);
  }
  return new DefaultDirector(systemPrompt, toolDefinitions, {});
}
