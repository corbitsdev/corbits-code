// Shared product-event emitters that every surface (TUI, exec, future
// headless) must call so dashboards are not silently TUI-only.

import type { ForcedStopReason } from "../subagent/stop-policy.js";
import type { SubAgentTelemetryRollup } from "../subagent/types.js";
import type { Telemetry } from "./index.js";
import { classifyCommandName } from "./classify.js";
import { getLastTurnTraceId } from "./feedback.js";

/** Emit slash_command with a classified first-party (or `custom`) name. */
export function captureSlashCommand(telemetry: Telemetry, commandName: string): void {
  telemetry.capture("slash_command", {
    command_name: classifyCommandName(commandName),
  });
}

export type CaptureSubagentEndArgs = {
  agentName: string;
  status: string;
  durationMs: number;
  /** Canonical model id from the provider, never a free-text source label. */
  model?: string;
  stopReason?: ForcedStopReason;
  rollup?: SubAgentTelemetryRollup;
  /** Override for tests; defaults to the last parent-turn trace id. */
  parentTraceId?: string | undefined;
};

/** Build allowlisted `subagent_end` properties from a finished run. */
export function buildSubagentEndProperties(
  args: CaptureSubagentEndArgs,
): Record<string, unknown> {
  const parentTraceId =
    args.parentTraceId !== undefined ? args.parentTraceId : getLastTurnTraceId();
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
  if (parentTraceId !== undefined && parentTraceId.length > 0) {
    props.parent_trace_id = parentTraceId;
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
