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

export const submitOutputDefinition: ToolDefinition = {
  name: "submitOutput",
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
}

const READ_TOOLS = new Set(["read_file", "list_dir", "search_files", "grep"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

class CodingDirectorImpl extends DefaultDirector implements CodingDirector {
  private submitCalled = false;
  private _turnsUsed = 0;
  private readonly maxTurns: number;
  private readonly callIdToName = new Map<string, string>();
  private idleCycles = 0;
  private consecutiveReads = 0;

  constructor(
    systemPrompt: string,
    toolDefinitions: ToolDefinition[],
    maxTurns: number,
    initialState?: DirectorPersistedState,
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

      if (this._turnsUsed >= this.maxTurns) {
        return [
          capabilities.checkpoint("max-turns"),
          capabilities.reply(`Max turns (${this.maxTurns}) reached.`),
        ];
      }
    }

    if (event.type === "tool.done") {
      const name = this.callIdToName.get(event.result.callId);
      if (name === "submitOutput" && !event.result.isError) {
        this.submitCalled = true;
      }
      if (name !== undefined) {
        if (READ_TOOLS.has(name)) {
          this.consecutiveReads++;
        } else if (WRITE_TOOLS.has(name)) {
          this.consecutiveReads = 0;
        }
      }
    }

    const actions = await super.decide(event, state, capabilities);

    if (this.consecutiveReads >= 7) {
      return [
        capabilities.checkpoint("read-abort"),
        capabilities.reply("Agent stalled: too many reads without writes."),
        capabilities.done(),
      ];
    }

    return actions;
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
      consecutiveReads: this.consecutiveReads,
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
    this.consecutiveReads = state.consecutiveReads ?? 0;
  }
}

export function createCodingDirector(
  systemPrompt: string,
  toolDefinitions: ToolDefinition[],
  maxTurns: number,
  initialState?: DirectorPersistedState,
): CodingDirector {
  return new CodingDirectorImpl(systemPrompt, toolDefinitions, maxTurns, initialState);
}
