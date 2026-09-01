import type { ToolCall, ToolDefinition, ToolResult } from "@intx/types/runtime";
import { type AgentTool, type AgentToolRunner, DuplicateToolError } from "@intx/agent";
import {
  resolveToolExecutionTimeoutMs,
  resolveWaitForApproval,
  runWithToolExecutionWatchdog,
  type ToolWatchdogConfig,
} from "./tool-execution-watchdog.js";
import { stripTerminalControlSequences } from "../util/control-char-strip.js";

// A tool runner whose set of tools can grow after construction. The static
// createToolRunner freezes its name map at build time, which cannot accommodate
// MCP servers that connect after the TUI has already started. This runner keeps
// a mutable map and exposes `addTools` so late-connected servers' tools become
// dispatchable in the running session. `definitions` is a live getter, and the
// director advertises the current set on each inference (see updateToolDefinitions).
//
// `watchdogConfig` is read on every run so Settings toggles (timeouts,
// waitForApproval) take effect on the next tool call without rebuilding tools.
export type DynamicToolRunner = AgentToolRunner & {
  addTools(tools: AgentTool[]): void;
  currentDefinitions(): ToolDefinition[];
};

export function createDynamicToolRunner(
  initial: AgentTool[],
  watchdogConfig?: ToolWatchdogConfig,
): DynamicToolRunner {
  const byName = new Map<string, AgentTool>();

  const addTools = (tools: AgentTool[]): void => {
    const incoming = new Set<string>();
    for (const tool of tools) {
      const name = tool.definition.name;
      if (byName.has(name) || incoming.has(name)) throw new DuplicateToolError(name);
      incoming.add(name);
    }
    for (const tool of tools) byName.set(tool.definition.name, tool);
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
      const executionTimeoutMs = resolveToolExecutionTimeoutMs(watchdogConfig, call);
      const waitForApproval = resolveWaitForApproval(watchdogConfig);
      const result = await runWithToolExecutionWatchdog(
        call,
        signal,
        executionTimeoutMs,
        async (budgetSignal) => {
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
        },
        { waitForApproval },
      );
      // Every tool result — posix, MCP, or built-in — passes through this single
      // dispatch point before reaching the reactor/renderer, so it is the one
      // place a terminal-control sanitizer needs to run.
      if (typeof result.content !== "string") return result;
      const sanitized = stripTerminalControlSequences(result.content);
      return sanitized === result.content ? result : { ...result, content: sanitized };
    },
  };
}
