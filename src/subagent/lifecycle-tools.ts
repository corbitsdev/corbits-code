/**
 * close_agent / resume_agent: the session-lifecycle half of
 * reusable worker sessions. spawn_agent/wait_agents start and
 * collect workers; these two verbs let an orchestrator tear one down on
 * purpose (close_agent) or bring a retained one back for further input
 * (resume_agent), instead of every session dying the instant its turn ends.
 *
 * interrupt_agent and followup_task (the verbs that actually push a new
 * prompt into a resumed session) are a separate, later change — resume_agent
 * here only flips a retained session back to an addressable state; it takes
 * no prompt argument.
 */

import { tool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import { type } from "arktype";
import type { ToolDefinition, ToolResult } from "@intx/types/runtime";

import { DEFAULT_CLOSE_DEADLINE_MS } from "./dispose.js";
import type { FleetRecordsHandle } from "./agent-fleet.js";
import type { AgentLifecycleStatus, SubAgentSessionStore } from "./session-store.js";

function lifecycleResult(callId: string, content: string): ToolResult {
  const isError = content.startsWith("Error:");
  return { callId, content, ...(isError ? { isError: true } : {}) };
}

const CloseAgentArgs = type({
  target: "string",
});

export const closeAgentToolDefinition: ToolDefinition = {
  name: "close_agent",
  description:
    "Permanently close a worker session by agent_id, closing its descendants first. Bounded " +
    `by a ~${Math.round(DEFAULT_CLOSE_DEADLINE_MS / 1000)}s cleanup deadline per session so a wedged worker cannot hang ` +
    "this call — a session that misses the deadline is still marked shutdown; its teardown just " +
    "keeps running in the background. Closing is permanent: a closed session cannot be resumed.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "agent_id of the session to close." },
    },
    required: ["target"],
  },
};

const ResumeAgentArgs = type({
  target: "string",
});

export const resumeAgentToolDefinition: ToolDefinition = {
  name: "resume_agent",
  description:
    "Reopen a retained, completed worker session (one that finished a turn and was never closed) " +
    "so it is addressable again. Fails on a session that is still running, was never retained, was " +
    "interrupted, or was already closed via close_agent (closing is permanent).",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "agent_id of the session to resume." },
    },
    required: ["target"],
  },
};

/** Every id in `target`'s subtree (nodes with target somewhere up their parentSessionId chain), deepest first, target last. */
function descendantsClosingOrder(
  nodes: readonly { id: string; parentSessionId?: string | undefined }[],
  target: string,
): string[] {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentSessionId === undefined) continue;
    const siblings = children.get(node.parentSessionId) ?? [];
    siblings.push(node.id);
    children.set(node.parentSessionId, siblings);
  }
  const order: string[] = [];
  const visit = (id: string): void => {
    for (const child of children.get(id) ?? []) visit(child);
    order.push(id);
  };
  visit(target);
  return order;
}

export interface LifecycleToolDeps {
  sessions: SubAgentSessionStore;
  /** Optional for close/resume/followup; interrupt requires it (see InterruptAgentToolDeps). */
  fleetRecords?: FleetRecordsHandle;
}

/** interrupt_agent always terminalizes the wait mailbox — no silent skip. */
export type InterruptAgentToolDeps = LifecycleToolDeps & {
  fleetRecords: FleetRecordsHandle;
};

export function createCloseAgentTool(deps: LifecycleToolDeps): AgentTool {
  return tool({
    definition: closeAgentToolDefinition,
    handler: async (call, _signal): Promise<ToolResult> => {
      const parsed = CloseAgentArgs(call.arguments);
      if (parsed instanceof type.errors) {
        return lifecycleResult(call.id, `Error: close_agent arguments invalid: ${parsed.summary}`);
      }
      const target = parsed.target.trim();
      if (deps.sessions.get(target) === undefined) {
        return lifecycleResult(
          call.id,
          JSON.stringify({ agent_id: target, status: "not_found" satisfies AgentLifecycleStatus }),
        );
      }
      const nodes = deps.sessions
        .list()
        .map((s) => ({ id: s.id, parentSessionId: s.parentSessionId }));
      const order = descendantsClosingOrder(nodes, target);
      const closed: { agent_id: string; status: AgentLifecycleStatus }[] = [];
      for (const id of order) {
        const status = await deps.sessions.closeOne(id, DEFAULT_CLOSE_DEADLINE_MS);
        closed.push({ agent_id: id, status });
      }
      const own = closed.find((c) => c.agent_id === target);
      return lifecycleResult(
        call.id,
        JSON.stringify({
          agent_id: target,
          status: own?.status ?? "shutdown",
          closed,
        }),
      );
    },
  });
}

export function createResumeAgentTool(deps: LifecycleToolDeps): AgentTool {
  return tool({
    definition: resumeAgentToolDefinition,
    handler: async (call, _signal): Promise<ToolResult> => {
      const parsed = ResumeAgentArgs(call.arguments);
      if (parsed instanceof type.errors) {
        return lifecycleResult(call.id, `Error: resume_agent arguments invalid: ${parsed.summary}`);
      }
      const target = parsed.target.trim();
      const outcome = deps.sessions.resumeOne(target);
      if (!outcome.ok) {
        const hint = outcome.hint !== undefined ? ` ${outcome.hint}` : "";
        return lifecycleResult(
          call.id,
          `Error: cannot resume "${target}" (status: ${outcome.status}).${hint}`,
        );
      }
      return lifecycleResult(call.id, JSON.stringify({ agent_id: target, status: "running" }));
    },
  });
}

const InterruptAgentArgs = type({
  target: "string",
});

export const interruptAgentToolDefinition: ToolDefinition = {
  name: "interrupt_agent",
  description:
    "Stop a worker session's current turn while keeping the session and its context intact and " +
    "reusable — distinct from close_agent, which is permanent. Unblocks any in-flight wait_agents " +
    "on this id immediately with status 'interrupted'. The worker's in-flight tool call or " +
    "inference keeps running in the background (there is no way to hard-stop it without tearing the " +
    "session down); this only stops the caller from waiting on it and marks the session " +
    "'interrupted' so followup_task or resume_agent can pick it back up with full prior context. " +
    "Fails on a session that is not currently running.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "agent_id of the session to interrupt." },
    },
    required: ["target"],
  },
};

export function createInterruptAgentTool(deps: InterruptAgentToolDeps): AgentTool {
  return tool({
    definition: interruptAgentToolDefinition,
    handler: async (call, _signal): Promise<ToolResult> => {
      const parsed = InterruptAgentArgs(call.arguments);
      if (parsed instanceof type.errors) {
        return lifecycleResult(
          call.id,
          `Error: interrupt_agent arguments invalid: ${parsed.summary}`,
        );
      }
      const target = parsed.target.trim();
      const outcome = deps.sessions.interruptOne(target);
      if (!outcome.ok) {
        return lifecycleResult(
          call.id,
          `Error: cannot interrupt "${target}" (status: ${outcome.status}).`,
        );
      }
      // Wait mailbox is separate from the TUI strip — flip it here so
      // wait_agents does not stay blocked on a still-"running" record.
      deps.fleetRecords.interrupt(target);
      return lifecycleResult(
        call.id,
        JSON.stringify({ agent_id: target, status: "interrupted" satisfies AgentLifecycleStatus }),
      );
    },
  });
}

const FollowupTaskArgs = type({
  target: "string",
  message: "string",
});

export const followupTaskToolDefinition: ToolDefinition = {
  name: "followup_task",
  description:
    "Send new work into an existing retained worker session (one that is 'completed' or " +
    "'interrupted'), reusing its prior context and tool outputs rather than starting a fresh worker. " +
    "Blocks until the worker replies to this new message, and returns its reply. Fails on a session " +
    "that was never retained, is still running, or was closed via close_agent (closing is permanent).",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "agent_id of the retained session to resume." },
      message: { type: "string", description: "The new instruction/message for the worker." },
    },
    required: ["target", "message"],
  },
};

export function createFollowupTaskTool(deps: LifecycleToolDeps): AgentTool {
  return tool({
    definition: followupTaskToolDefinition,
    handler: async (call, _signal): Promise<ToolResult> => {
      const parsed = FollowupTaskArgs(call.arguments);
      if (parsed instanceof type.errors) {
        return lifecycleResult(
          call.id,
          `Error: followup_task arguments invalid: ${parsed.summary}`,
        );
      }
      const target = parsed.target.trim();
      const message = parsed.message.trim();
      if (message.length === 0) {
        return lifecycleResult(call.id, "Error: followup_task requires a non-empty message.");
      }
      const outcome = await deps.sessions.followupOne(target, message);
      if (!outcome.ok) {
        const hint = outcome.hint !== undefined ? ` ${outcome.hint}` : "";
        return lifecycleResult(
          call.id,
          `Error: cannot send followup to "${target}" (status: ${outcome.status}).${hint}`,
        );
      }
      return lifecycleResult(
        call.id,
        JSON.stringify({ agent_id: target, status: "completed", reply: outcome.reply }),
      );
    },
  });
}
