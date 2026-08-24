/**
 * `read_agent_trace` tool (CL-6951): lets an orchestrator or nested
 * orchestrator inspect what a worker has actually done on disk — its turns,
 * tool calls, and errors — even if the worker is still running or was
 * cancelled/interrupted and its in-memory session record is gone.
 *
 * Only orchestrator tiers may hold this tool; see authority.ts /
 * assertTierMayMountFleetVerb for the mount-point gate. Leaves never see it.
 */

import { stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";

import {
  AgentTraceNotFoundError,
  readAgentTrace,
  type TraceEntryKind,
  type TraceReadResult,
} from "./trace-reader.js";
import {
  assertCanTargetAgent,
  FleetAuthorityError,
  type FleetNode,
  type SubagentTier,
} from "./authority.js";

/**
 * Descendant-scoping context for a Tier 2 nested orchestrator's copy of this
 * tool. `actorId` is this worker's own SubAgentSessionStore id (the same id
 * used as its on-disk directory name — see run.ts) and `getNodes` returns
 * the live fleet so `assertCanTargetAgent` can walk the existing
 * parentSessionId chain rather than trusting a per-caller check that could
 * be forgotten at a future mount site. Omit entirely for Tier 1 (the
 * primary orchestrator), which may target anyone.
 */
export interface ReadAgentTraceAuthority {
  actorId: string | undefined;
  tier: SubagentTier;
  getNodes: () => readonly FleetNode[];
}

const TRACE_ENTRY_KINDS: readonly TraceEntryKind[] = [
  "text",
  "thinking",
  "tool_call",
  "tool_result",
  "error",
];

export const readAgentTraceDefinition: ToolDefinition = {
  name: "read_agent_trace",
  description:
    "Read a worker's on-disk trace — its turns, tool calls, and errors — directly from " +
    "disk, so you can see what it has actually done even if it is still running, was " +
    "cancelled, or was interrupted. Returns a bounded window; a truncated response tells " +
    "you what was omitted and how to page for the rest.",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "Worker id (the id you spawned/see for it) whose trace to read.",
      },
      kinds: {
        type: "array",
        items: { type: "string", enum: [...TRACE_ENTRY_KINDS] },
        description:
          "Only return entries of these kinds (text, thinking, tool_call, tool_result, error). Omit for all kinds.",
      },
      fromTurn: {
        type: "number",
        description: "0-based inclusive start turn index. Omit to default to the recent tail.",
      },
      toTurn: {
        type: "number",
        description: "0-based exclusive end turn index. Omit to default to the end of the trace.",
      },
      limit: {
        type: "number",
        description: "Max entries to return (default 200, hard cap 500).",
      },
    },
    required: ["target"],
  },
};

const ReadAgentTraceArgs = type({
  target: "string",
  "kinds?": "('text'|'thinking'|'tool_call'|'tool_result'|'error')[]",
  "fromTurn?": "number",
  "toTurn?": "number",
  "limit?": "number",
});

function formatTraceResult(result: TraceReadResult): string {
  const lines: string[] = [
    `agent: ${result.agentId}`,
    `turns: ${result.fromTurn}-${result.toTurn} of ${result.totalTurns} total`,
  ];
  if (result.parseWarnings > 0) {
    lines.push(`(skipped ${result.parseWarnings} malformed/partial line(s) while reading)`);
  }
  if (result.entries.length === 0) {
    lines.push("", "No matching entries in this range.");
  } else {
    lines.push("");
    for (const entry of result.entries) {
      const tag = entry.name !== undefined ? `${entry.kind}:${entry.name}` : entry.kind;
      const callId = entry.callId !== undefined ? ` [${entry.callId}]` : "";
      const truncatedMark = entry.truncated === true ? " …[truncated]" : "";
      lines.push(`--- turn ${entry.turn} ${entry.role} ${tag}${callId} ---`);
      lines.push(`${entry.content}${truncatedMark}`);
    }
  }
  if (result.omitted !== null) {
    lines.push(
      "",
      `[omitted: ${result.omitted.reason}; ${result.omitted.turnsBefore} turn(s) before, ` +
        `${result.omitted.turnsAfter} turn(s) after this window — ${result.omitted.hint}]`,
    );
  }
  return lines.join("\n");
}

export function createReadAgentTraceTool(
  getRootWorkdirBase: () => string,
  authority?: ReadAgentTraceAuthority,
): AgentTool {
  return stringTool({
    definition: readAgentTraceDefinition,
    handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
      const parsed = ReadAgentTraceArgs(rawArgs);
      if (parsed instanceof type.errors) {
        return `Error: read_agent_trace requires target (string); ${parsed.summary}`;
      }
      if (authority !== undefined) {
        // Fails closed: an actor whose own store id could not be resolved
        // (no session record for this dispatch) must never be trusted with
        // fleet-wide read access, mirroring CL-6941's unresolved-tier rule.
        if (authority.actorId === undefined) {
          return (
            "Error: read_agent_trace is unavailable for this worker (no resolvable session " +
            "id to scope descendant access)."
          );
        }
        try {
          assertCanTargetAgent(
            { id: authority.actorId, tier: authority.tier },
            parsed.target,
            authority.getNodes(),
          );
        } catch (cause) {
          if (cause instanceof FleetAuthorityError) return `Error: ${cause.message}`;
          throw cause;
        }
      }
      try {
        const result = await readAgentTrace(getRootWorkdirBase(), parsed.target, {
          ...(parsed.kinds !== undefined ? { kinds: parsed.kinds } : {}),
          ...(parsed.fromTurn !== undefined ? { fromTurn: parsed.fromTurn } : {}),
          ...(parsed.toTurn !== undefined ? { toTurn: parsed.toTurn } : {}),
          ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
        });
        return formatTraceResult(result);
      } catch (cause) {
        if (cause instanceof AgentTraceNotFoundError) return `Error: ${cause.message}`;
        throw cause;
      }
    },
  });
}
