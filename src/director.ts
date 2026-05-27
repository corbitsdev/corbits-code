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

class CodingDirector extends DefaultDirector implements ReactorDirector {
  private submitCalled = false;
  private turnsUsed = 0;
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
      this.turnsUsed++;

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
            capabilities.done(),
          ];
        }
      }

      if (this.turnsUsed >= this.maxTurns) {
        return [
          capabilities.checkpoint("max-turns"),
          capabilities.reply(`Max turns (${this.maxTurns}) reached.`),
          capabilities.done(),
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
}

export function createCodingDirector(
  systemPrompt: string,
  toolDefinitions: ToolDefinition[],
  maxTurns: number,
): ReactorDirector {
  return new CodingDirector(systemPrompt, toolDefinitions, maxTurns);
}
