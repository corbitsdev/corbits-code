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

export function createReadAgentTraceTool(getRootWorkdirBase: () => string): AgentTool {
  return stringTool({
    definition: readAgentTraceDefinition,
    handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
      const parsed = ReadAgentTraceArgs(rawArgs);
      if (parsed instanceof type.errors) {
        return `Error: read_agent_trace requires target (string); ${parsed.summary}`;
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
