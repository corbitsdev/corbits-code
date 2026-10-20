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
import { prepareDispatchedToolCall } from "./tool-aliases.js";
import { UNADVERTISED_MOUNTED_BUILTINS } from "./tool-search.js";

// A tool runner whose tool set can grow after construction: the static
// createToolRunner freezes its name map at build time, which cannot
// accommodate MCP servers that connect after the TUI has started.
// `watchdogConfig` is read on every run so Settings toggles take effect on
// the next tool call without rebuilding tools.
export type DynamicToolRunner = AgentToolRunner & {
  addTools(tools: AgentTool[]): void;
  removeTools(names: string[]): void;
  currentDefinitions(): ToolDefinition[];
  /**
   * When a gate is set, a registered tool whose name is off the current
   * wire (built-in prefix + pinned + activated) is interceptable:
   * `setOnUndeclaredCall` declares the one name (promote-on-execute) and
   * run() re-checks the gate, then dispatches; otherwise it errors toward
   * tool_search. Without a gate every registered tool stays dispatchable —
   * sub-agent runners never set one.
   *
   * `options.isActivated` is the promotion side: an activated-but-unregistered
   * name reports "not currently available, server may be reconnecting"
   * rather than the bare unknown-tool string.
   */
  setCallGate(
    isCallable: (name: string) => boolean,
    options?: { isActivated?: (name: string) => boolean },
  ): void;
  /**
   * Session promoter for a known-but-unadvertised call: declare that one
   * name (activate + flush), then dispatch. Search loads only the top
   * ranked hits; this path covers a called name outside that prefix, plus
   * director-side triggers.
   */
  setOnUndeclaredCall(handler: (name: string) => void): void;
  /**
   * Record the current tool set as the one the agent being built can
   * authorize. The reactor snapshots definitions at build, so a tool mounted
   * later would reach dispatch with no approval snapshot. Until the next pin,
   * `agentDefinitions` hides such tools and `isLateTool` names them. A runner
   * that is never pinned exposes every registered tool.
   */
  pinAgentToolSet(): void;
  // Registered tools the pinned agent can authorize (all of them unpinned).
  agentDefinitions(): ToolDefinition[];
  // A name that resolves to a registered tool the pinned agent lacks.
  isLateTool(name: string): boolean;
  // How the registry moved since the last pin; empty when never pinned.
  agentToolSetDrift(): AgentToolSetDrift;
};

interface AgentToolSetDrift {
  added: string[];
  removed: string[];
  changed: string[];
}

// Description and schema are what the approval snapshot and the wire carry.
const definitionShape = (definition: ToolDefinition): string =>
  `${definition.description ?? ""}|${JSON.stringify(definition.inputSchema ?? null)}`;

export function createDynamicToolRunner(
  initial: AgentTool[],
  watchdogConfig?: ToolWatchdogConfig,
): DynamicToolRunner {
  const byName = new Map<string, AgentTool>();
  let callGate: ((name: string) => boolean) | undefined;
  let isActivated: ((name: string) => boolean) | undefined;
  let onUndeclaredCall: ((name: string) => void) | undefined;
  // Pinned while the agent's tool resolution walks the bundle, where the
  // live-dispatch shim swaps the global Map; arrays and a Set stay clear of it.
  let pinned: { names: Set<string>; definitions: ToolDefinition[] } | undefined;

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

  const agentDefinitions = (): ToolDefinition[] => {
    const live = currentDefinitions();
    if (pinned === undefined) return live;
    const names = pinned.names;
    return live.filter((definition) => names.has(definition.name));
  };

  const isLateTool = (name: string): boolean => {
    if (pinned === undefined) return false;
    const resolved = resolveRegisteredToolName(name, (n) => byName.has(n));
    return resolved !== undefined && !pinned.names.has(resolved);
  };

  const agentToolSetDrift = (): AgentToolSetDrift => {
    if (pinned === undefined) return { added: [], removed: [], changed: [] };
    // The pin holds the same definition objects the live set walks on an idle
    // tool set. Remember the shape by identity for this call so each schema is
    // serialized once, not again inside the changed filter.
    const shapes = new WeakMap<ToolDefinition, string>();
    const shapeOf = (definition: ToolDefinition): string => {
      const cached = shapes.get(definition);
      if (cached !== undefined) return cached;
      const shape = definitionShape(definition);
      shapes.set(definition, shape);
      return shape;
    };
    const pinnedShapes = new Map(
      pinned.definitions.map((definition) => [
        definition.name,
        shapeOf(definition),
      ]),
    );
    const live = currentDefinitions();
    const liveNames = new Set(live.map((definition) => definition.name));
    return {
      added: live
        .filter((definition) => !pinnedShapes.has(definition.name))
        .map((definition) => definition.name),
      removed: [...pinnedShapes.keys()].filter((name) => !liveNames.has(name)),
      changed: live
        .filter((definition) => {
          const before = pinnedShapes.get(definition.name);
          return before !== undefined && before !== shapeOf(definition);
        })
        .map((definition) => definition.name),
    };
  };

  return {
    get definitions(): readonly ToolDefinition[] {
      return currentDefinitions();
    },
    addTools,
    removeTools,
    currentDefinitions,
    pinAgentToolSet(): void {
      const definitions = currentDefinitions();
      pinned = {
        names: new Set(definitions.map((definition) => definition.name)),
        definitions,
      };
    },
    agentDefinitions,
    isLateTool,
    agentToolSetDrift,
    setCallGate(
      isCallable: (name: string) => boolean,
      options?: { isActivated?: (name: string) => boolean },
    ): void {
      callGate = isCallable;
      isActivated = options?.isActivated;
    },
    setOnUndeclaredCall(handler: (name: string) => void): void {
      onUndeclaredCall = handler;
    },
    async run(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
      const resolved = resolveRegisteredToolName(call.name, (name) =>
        byName.has(name),
      );
      if (resolved === undefined) {
        // Promoted (gate-activated) but the registry no longer holds it —
        // the server dropped between search and call. Say so: the name was
        // already promoted, so retry rather than re-search. A name never
        // activated keeps the exact unknown-tool string.
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
      // A registered tool off the advertised wire: declare that one name
      // (strict providers see it on the session tool list before dispatch),
      // then run the call. Search already loaded the top ranked hits; this
      // covers a called name outside that prefix. If the promoter cannot
      // admit the name (closed overlay, denied family), the gate still
      // fails and the model is pointed at tool_search.
      // Unadvertised mounted builtins (list_dir) stay off the wire — search
      // hides them in favor of glob — so intercept dispatches without
      // flushPromotions rather than advertising until fold.
      if (callGate !== undefined && !callGate(resolved)) {
        if (!UNADVERTISED_MOUNTED_BUILTINS.has(resolved)) {
          onUndeclaredCall?.(resolved);
          if (!callGate(resolved)) {
            return {
              callId: call.id,
              content:
                `Error: ${resolved} is not in the currently advertised tool list. ` +
                `Call tool_search to find it, then retry the call.`,
              isError: true,
            };
          }
        }
      }
      let dispatchCall: ToolCall;
      try {
        dispatchCall = prepareDispatchedToolCall(call, resolved);
      } catch (err) {
        return {
          callId: call.id,
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
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
