// Shared product-event emitters that every surface (TUI, exec, future
// headless) must call so dashboards are not silently TUI-only.

import type { ForcedStopReason } from "../subagent/stop-policy.js";
import type { SubAgentTelemetryRollup } from "../subagent/types.js";
import type { Telemetry } from "./index.js";
import { classifyCommandName } from "./classify.js";

/** Emit slash_command with a classified first-party (or `custom`) name. */
export function captureSlashCommand(telemetry: Telemetry, commandName: string): void {
  telemetry.capture("slash_command", {
    command_name: classifyCommandName(commandName),
  });
}

export interface CaptureSubagentEndArgs {
  agentName: string;
  status: string;
  durationMs: number;
  /** Canonical model id from the provider, never a free-text source label. */
  model?: string;
  stopReason?: ForcedStopReason;
  rollup?: SubAgentTelemetryRollup;
  /**
   * Spawn-time parent `$ai_trace_id` (in-flight turn). Callers must capture
   * this at dispatch — never default to the last *completed* turn.
   */
  parentTraceId?: string | undefined;
}

/** Build allowlisted `subagent_end` properties from a finished run. */
export function buildSubagentEndProperties(args: CaptureSubagentEndArgs): Record<string, unknown> {
  const props: Record<string, unknown> = {
    agent_name: args.agentName,
    status: args.status,
    duration_ms: args.durationMs,
  };
  if (args.model !== undefined && args.model.length > 0) {
    props.model = args.model;
  }
  if (args.stopReason !== undefined) {
    props.stop_reason = args.stopReason;
  }
  if (args.parentTraceId !== undefined && args.parentTraceId.length > 0) {
    props.parent_trace_id = args.parentTraceId;
  }
  if (args.rollup !== undefined) {
    props.turn_count = args.rollup.turn_count;
    props.input_tokens = args.rollup.input_tokens;
    props.output_tokens = args.rollup.output_tokens;
    props.cache_read_tokens = args.rollup.cache_read_tokens;
    props.cache_write_tokens = args.rollup.cache_write_tokens;
    props.reasoning_tokens = args.rollup.reasoning_tokens;
    props.tool_call_count = args.rollup.tool_call_count;
    props.tool_error_count = args.rollup.tool_error_count;
  }
  return props;
}

/** Emit `subagent_end` with rollup fields when available. */
export function captureSubagentEnd(telemetry: Telemetry, args: CaptureSubagentEndArgs): void {
  telemetry.capture("subagent_end", buildSubagentEndProperties(args));
}

// Process-scoped: the same plugin can be discovered via several paths in one
// session (repo + project overlay, reloads). Only the first successful load
// emits; only `origin` is transmitted.
const loadedPluginIdentities = new Set<string>();

export function capturePluginLoaded(telemetry: Telemetry, origin: string, identity: string): void {
  if (identity.length === 0) return;
  if (loadedPluginIdentities.has(identity)) return;
  loadedPluginIdentities.add(identity);
  telemetry.capture("plugin_loaded", { origin });
}

/** Test helper — clears the process-scoped plugin_loaded dedupe set. */
export function resetPluginLoadedDedupeForTests(): void {
  loadedPluginIdentities.clear();
}
