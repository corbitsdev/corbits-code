import { DefaultDirector } from "@intx/inference";
import type {
  ReactorDirector,
  ReactorInboundEvent,
  ReactorState,
  ReactorCapabilities,
  ReactorAction,
  ToolDefinition,
} from "@intx/types/runtime";

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
}

class CodingDirectorImpl extends DefaultDirector implements CodingDirector {
  private submitCalled = false;
  private _turnsUsed = 0;
  private readonly maxTurns: number;
  private readonly callIdToName = new Map<string, string>();

  constructor(
    systemPrompt: string,
    toolDefinitions: ToolDefinition[],
    maxTurns: number,
  ) {
    super(systemPrompt, toolDefinitions, {});
    this.maxTurns = maxTurns;
  }

  override async decide(
    event: ReactorInboundEvent,
    state: ReactorState,
    capabilities: ReactorCapabilities,
  ): Promise<ReactorAction | ReactorAction[]> {
    if (event.type === "inference.done") {
      this._turnsUsed++;

      for (const block of event.turn.content) {
        if (block.type === "tool_call") {
          this.callIdToName.set(block.id, block.name);
        }
      }

      if (this.submitCalled) {
        const hasToolCalls = event.turn.content.some(
          (b) => b.type === "tool_call",
        );
        if (!hasToolCalls) {
          return [
            capabilities.checkpoint("submit-accepted"),
            capabilities.reply("Task completed."),
          ];
        }
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
    }

    return super.decide(event, state, capabilities);
  }

  getTurnsUsed(): number {
    return this._turnsUsed;
  }
}

export function createCodingDirector(
  systemPrompt: string,
  toolDefinitions: ToolDefinition[],
  maxTurns: number,
): CodingDirector {
  return new CodingDirectorImpl(systemPrompt, toolDefinitions, maxTurns);
}
