import type { ToolCall, ToolDefinition, ToolResult } from "@intx/types/runtime";
import { type AgentTool, type AgentToolRunner, DuplicateToolError } from "@intx/agent";
import {
  resolveToolExecutionTimeoutMs,
  runWithToolExecutionWatchdog,
  type ToolWatchdogConfig,
} from "./tool-execution-watchdog.js";

// A tool runner whose set of tools can grow after construction. The static
// createToolRunner freezes its name map at build time, which cannot accommodate
// MCP servers that connect after the TUI has already started. This runner keeps
// a mutable map and exposes `addTools` so late-connected servers' tools become
// dispatchable in the running session. `definitions` is a live getter, and the
// director advertises the current set on each inference (see updateToolDefinitions).
export type DynamicToolRunner = AgentToolRunner & {
  addTools(tools: AgentTool[]): void;
  currentDefinitions(): ToolDefinition[];
};

export function createDynamicToolRunner(
  initial: AgentTool[],
  watchdogConfig?: ToolWatchdogConfig,
): DynamicToolRunner {
  const executionTimeoutMs = resolveToolExecutionTimeoutMs(watchdogConfig);
  const byName = new Map<string, AgentTool>();

  const addTools = (tools: AgentTool[]): void => {
    for (const t of tools) {
      if (byName.has(t.definition.name)) {
        throw new DuplicateToolError(t.definition.name);
      }
      byName.set(t.definition.name, t);
    }
  };

  addTools(initial);

  const currentDefinitions = (): ToolDefinition[] => [...byName.values()].map((t) => t.definition);

  return {
    get definitions(): readonly ToolDefinition[] {
      return currentDefinitions();
    },
    addTools,
    currentDefinitions,
    async run(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
      const found = byName.get(call.name);
      if (found === undefined) {
        return { callId: call.id, content: `unknown tool: ${call.name}`, isError: true };
      }
      return runWithToolExecutionWatchdog(call, signal, executionTimeoutMs, async (budgetSignal) => {
        try {
          if (found.kind === "full") return await found.handler(call, budgetSignal);
          const text = await found.handler(call.arguments, budgetSignal);
          return { callId: call.id, content: text };
        } catch (err) {
          return {
            callId: call.id,
            content: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }
      });
    },
  };
}
