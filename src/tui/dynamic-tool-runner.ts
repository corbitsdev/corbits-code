import type { ToolCall, ToolDefinition, ToolResult } from "@intx/types/runtime";
import {
  type AgentTool,
  type AgentToolRunner,
  DuplicateToolError,
} from "@intx/agent";
import {
  resolveToolExecutionTimeoutMs,
  resolveWaitForApproval,
  runWithToolExecutionWatchdog,
  type ToolWatchdogConfig,
} from "./tool-execution-watchdog.js";
import { resolveRegisteredToolName } from "./resolve-registered-tool-name.js";
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
  removeTools(names: string[]): void;
  currentDefinitions(): ToolDefinition[];
  /**
   * When a gate is set, run() refuses a registered tool whose name is not on
   * the current wire (built-in prefix + pinned + activated) with an error
   * pointing at tool_search, instead of silently dispatching. Without a gate
   * every registered tool stays dispatchable — sub-agent runners never set one.
   *
   * `options.isActivated` is the promotion side of the gate: a name the model
   * was already shown (tool_search activated it) that is absent from the
   * registry — its server disconnected or the snapshot rebuilt under it —
   * reports "not currently available, server may be reconnecting, retry
   * shortly" instead of the bare unknown-tool string. Names never activated
   * keep the exact unknown-tool string.
   */
  setCallGate(
    isCallable: (name: string) => boolean,
    options?: { isActivated?: (name: string) => boolean },
  ): void;
};

export function createDynamicToolRunner(
  initial: AgentTool[],
  watchdogConfig?: ToolWatchdogConfig,
): DynamicToolRunner {
  const byName = new Map<string, AgentTool>();
  let callGate: ((name: string) => boolean) | undefined;
  let isActivated: ((name: string) => boolean) | undefined;

  const addTools = (tools: AgentTool[]): void => {
    const incoming = new Set<string>();
    for (const tool of tools) {
      const name = tool.definition.name;
      if (byName.has(name) || incoming.has(name))
        throw new DuplicateToolError(name);
      incoming.add(name);
    }
    for (const tool of tools) byName.set(tool.definition.name, tool);
  };

  const removeTools = (names: string[]): void => {
    for (const name of names) byName.delete(name);
  };

  addTools(initial);

  const currentDefinitions = (): ToolDefinition[] =>
    [...byName.values()].map((t) => t.definition);

  return {
    get definitions(): readonly ToolDefinition[] {
      return currentDefinitions();
    },
    addTools,
    removeTools,
    currentDefinitions,
    setCallGate(
      isCallable: (name: string) => boolean,
      options?: { isActivated?: (name: string) => boolean },
    ): void {
      callGate = isCallable;
      isActivated = options?.isActivated;
    },
    async run(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
      const resolved = resolveRegisteredToolName(call.name, (name) =>
        byName.has(name),
      );
      if (resolved === undefined) {
        // The name was promoted (gate-activated) but the registry no longer
        // holds it — the server dropped between search and call. Say so: the
        // model already has the schema from the tool_search card and only
        // needs to retry, not re-search. A name never activated keeps the
        // exact unknown-tool string.
        if (isActivated?.(call.name) === true) {
          return {
            callId: call.id,
            content:
              `Error: ${call.name} is not currently available - its server may ` +
              `still be reconnecting. Retry the call shortly.`,
            isError: true,
          };
        }
        // A harness-namespaced call (`default.<stripped>`) misses the registry
        // under its original name even though the model was shown `<stripped>`:
        // consult activation with the stripped form too, but keep the original
        // name in the message so the transcript matches what the model emitted.
        const dot = call.name.indexOf(".");
        if (dot > 0) {
          const stripped = call.name.slice(dot + 1);
          if (stripped.length > 0 && isActivated?.(stripped) === true) {
            return {
              callId: call.id,
              content:
                `Error: ${call.name} is not currently available - its server may ` +
                `still be reconnecting. Retry the call shortly.`,
              isError: true,
            };
          }
        }
        return {
          callId: call.id,
          content: `unknown tool: ${call.name}`,
          isError: true,
        };
      }
      const found = byName.get(resolved);
      if (found === undefined) {
        return {
          callId: call.id,
          content: `unknown tool: ${call.name}`,
          isError: true,
        };
      }
      // The model can only intend a name it saw on the wire. A registered tool
      // the wire no longer advertises (activation state lost across a rebuild,
      // or a name the model emitted unaided) must fail loudly with a route back
      // to tool_search — silently dispatching it leaves the transcript claiming
      // a call the next infer's wire does not declare.
      if (callGate !== undefined && !callGate(resolved)) {
        return {
          callId: call.id,
          content:
            `Error: ${resolved} is not in the currently advertised tool list. ` +
            `Call tool_search to activate it, then retry the call.`,
          isError: true,
        };
      }
      const dispatchCall =
        resolved === call.name ? call : { ...call, name: resolved };
      const executionTimeoutMs = resolveToolExecutionTimeoutMs(
        watchdogConfig,
        dispatchCall,
      );
      const waitForApproval = resolveWaitForApproval(watchdogConfig);
      const result = await runWithToolExecutionWatchdog(
        dispatchCall,
        signal,
        executionTimeoutMs,
        async (budgetSignal) => {
          try {
            if (found.kind === "full")
              return await found.handler(dispatchCall, budgetSignal);
            const text = await found.handler(
              dispatchCall.arguments,
              budgetSignal,
            );
            return { callId: dispatchCall.id, content: text };
          } catch (err) {
            return {
              callId: call.id,
              content: err instanceof Error ? err.message : String(err),
              isError: true,
            };
          }
        },
        {
          waitForApproval,
          ...(watchdogConfig?.salvageGraceMs !== undefined
            ? { salvageGraceMs: watchdogConfig.salvageGraceMs }
            : {}),
        },
      );
      // Every tool result — posix, MCP, or built-in — passes through this single
      // dispatch point before reaching the reactor/renderer, so it is the one
      // place a terminal-control sanitizer needs to run.
      if (typeof result.content !== "string") return result;
      const sanitized = stripTerminalControlSequences(result.content);
      return sanitized === result.content
        ? result
        : { ...result, content: sanitized };
    },
  };
}
