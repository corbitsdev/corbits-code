// Shared product-event emitters that every surface (TUI, exec, future
// headless) must call so dashboards are not silently TUI-only.

import type {
  SubAgentTelemetryRollup,
  SubAgentTerminalReason,
} from "../subagent/types.js";
import type { Telemetry } from "./index.js";
import { classifyCommandName, classifySkillName } from "./classify.js";

/** Emit slash_command with a classified first-party (or `custom`) name. */
export function captureSlashCommand(
  telemetry: Telemetry,
  commandName: string,
): void {
  telemetry.capture("slash_command", {
    command_name: classifyCommandName(commandName),
  });
}

/** Emit skill_used with a classified first-party (or `custom`) skill name. */
export function captureSkillUsed(
  telemetry: Telemetry,
  skillName: string,
): void {
  telemetry.capture("skill_used", {
    skill_name: classifySkillName(skillName),
  });
}

export interface CaptureSubagentEndArgs {
  agentName: string;
  status: string;
  durationMs: number;
  /** Setup (worktree snapshot, admission, lane checks) elapsed; omit when unknown. */
  setupMs?: number;
  /** Canonical model id from the provider, never a free-text source label. */
  model?: string;
  stopReason?: SubAgentTerminalReason | "setup_error";
  rollup?: SubAgentTelemetryRollup;
  /**
   * Spawn-time parent `$ai_trace_id` (in-flight turn). Callers must capture
   * this at dispatch — never default to the last *completed* turn.
   */
  parentTraceId?: string | undefined;
}

/** Build allowlisted `subagent_end` properties from a finished run. */
export function buildSubagentEndProperties(
  args: CaptureSubagentEndArgs,
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    agent_name: args.agentName,
    status: args.status,
    duration_ms: args.durationMs,
  };
  if (args.setupMs !== undefined) {
    props.setup_ms = args.setupMs;
  }
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
    props.tool_read_count = args.rollup.tool_read_count;
    props.tool_write_count = args.rollup.tool_write_count;
    props.tool_shell_count = args.rollup.tool_shell_count;
    props.tool_search_count = args.rollup.tool_search_count;
    props.tool_agent_count = args.rollup.tool_agent_count;
    props.tool_other_count = args.rollup.tool_other_count;
    props.hydrate_ms = args.rollup.hydrate_ms;
  }
  return props;
}

/** Emit `subagent_end` with rollup fields when available. */
export function captureSubagentEnd(
  telemetry: Telemetry,
  args: CaptureSubagentEndArgs,
): void {
  telemetry.capture("subagent_end", buildSubagentEndProperties(args));
}

export type PluginLoadReporter = (
  telemetry: Telemetry,
  origin: string,
  identity: string,
) => void;

export function createPluginLoadReporter(): PluginLoadReporter {
  const loadedPluginIdentities = new Set<string>();
  return (telemetry, origin, identity) => {
    if (
      !telemetry.enabled ||
      identity.length === 0 ||
      loadedPluginIdentities.has(identity)
    )
      return;
    telemetry.capture("plugin_loaded", { origin });
    loadedPluginIdentities.add(identity);
  };
}
