/**
 * close_agent / resume_agent: the session-lifecycle half of
 * reusable worker sessions. spawn_agent/wait_agents start and
 * collect workers; these two verbs let an orchestrator tear one down on
 * purpose (close_agent) or start the next turn on a retained completed
 * or interrupted session (resume_agent), returning immediately so
 * wait_agents collects. send_input steers an in-flight running turn.
 */

import { tool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import { type } from "arktype";
import type { ToolDefinition, ToolResult } from "@intx/types/runtime";

import { DEFAULT_CLOSE_DEADLINE_MS } from "./dispose.js";
import type { FleetMailboxHandle } from "./agent-fleet.js";
import {
  DEFAULT_MAX_ENTRY_CHARS,
  type AgentLifecycleStatus,
  type SubAgentSessionStore,
} from "./session-store.js";
import {
  assertCanTargetAgent,
  FleetAuthorityError,
  type FleetNode,
  type SubagentTier,
} from "./authority.js";

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
    "keeps running in the background. Unblocks any in-flight wait_agents on these ids immediately with " +
    "status 'interrupted'. Closing is permanent: a closed session cannot be resumed.",
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
  message: "string",
});

export const resumeAgentToolDefinition: ToolDefinition = {
  name: "resume_agent",
  description:
    "Start the next turn on a retained worker that is 'completed' or 'interrupted', reusing its " +
    "prior context rather than spawning a fresh worker. Returns immediately with status 'running'; " +
    "collect the reply with wait_agents. Fails on a session that is still running, was never " +
    "retained, or was already closed via close_agent (closing is permanent).",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "agent_id of the retained session to resume." },
      message: {
        type: "string",
        description: `The new instruction/message for the worker (non-empty, max ${DEFAULT_MAX_ENTRY_CHARS} characters).`,
      },
    },
    required: ["target", "message"],
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

/**
 * Nested-orchestrator subtree gate for addressing verbs. When `authority` is
 * omitted (Tier-1 primary mount), targeting is unrestricted. When present,
 * a missing `actorId` fails closed — same rule as read_agent_trace.
 */
export interface LifecycleAuthority {
  actorId: string | undefined;
  tier: SubagentTier;
  getNodes: () => readonly FleetNode[];
}

export interface LifecycleToolDeps {
  sessions: SubAgentSessionStore;
  /** Optional for send_input; close, interrupt, and resume require it. */
  fleetRecords?: FleetMailboxHandle;
  authority?: LifecycleAuthority;
}

/** close_agent always terminalizes the wait mailbox — no silent skip. */
export type CloseAgentToolDeps = LifecycleToolDeps & {
  fleetRecords: FleetMailboxHandle;
};

/** interrupt_agent stamps session interrupted; wait JSON projects that lifecycle. */
export type InterruptAgentToolDeps = LifecycleToolDeps & {
  fleetRecords: FleetMailboxHandle;
};

/** resume_agent registers the next turn on the wait mailbox so wait_agents can collect. */
export type ResumeAgentToolDeps = LifecycleToolDeps & {
  fleetRecords: FleetMailboxHandle;
};

function gateTarget(
  deps: LifecycleToolDeps,
  toolName: string,
  target: string,
  callId: string,
): ToolResult | undefined {
  if (deps.authority === undefined) return undefined;
  if (deps.authority.actorId === undefined) {
    return lifecycleResult(
      callId,
      `Error: ${toolName} is unavailable for this worker (no resolvable session ` +
        "id to scope descendant access).",
    );
  }
  try {
    assertCanTargetAgent(
      { id: deps.authority.actorId, tier: deps.authority.tier },
      target,
      deps.authority.getNodes(),
    );
  } catch (cause) {
    if (cause instanceof FleetAuthorityError) {
      return lifecycleResult(callId, `Error: ${cause.message}`);
    }
    throw cause;
  }
  return undefined;
}

export function createCloseAgentTool(deps: CloseAgentToolDeps): AgentTool {
  return tool({
    definition: closeAgentToolDefinition,
    handler: async (call, _signal): Promise<ToolResult> => {
      const parsed = CloseAgentArgs(call.arguments);
      if (parsed instanceof type.errors) {
        return lifecycleResult(call.id, `Error: close_agent arguments invalid: ${parsed.summary}`);
      }
      const target = parsed.target.trim();
      const denied = gateTarget(deps, "close_agent", target, call.id);
      if (denied !== undefined) return denied;
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
        // Terminalize the wait mailbox before teardown. closeOne flips strip
        // status to "cancelled", which kills the soft-interrupt fallback that
        // still requires status === "running" — without this, in-flight
        // wait_agents hangs until timeout.
        deps.fleetRecords.interrupt(id);
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

export function createResumeAgentTool(deps: ResumeAgentToolDeps): AgentTool {
  return tool({
    definition: resumeAgentToolDefinition,
    handler: async (call, _signal): Promise<ToolResult> => {
      const parsed = ResumeAgentArgs(call.arguments);
      if (parsed instanceof type.errors) {
        return lifecycleResult(call.id, `Error: resume_agent arguments invalid: ${parsed.summary}`);
      }
      const target = parsed.target.trim();
      const denied = gateTarget(deps, "resume_agent", target, call.id);
      if (denied !== undefined) return denied;
      const message = parsed.message.trim();
      if (message.length === 0) {
        return lifecycleResult(call.id, "Error: resume_agent requires a non-empty message.");
      }
      if (message.length > DEFAULT_MAX_ENTRY_CHARS) {
        return lifecycleResult(
          call.id,
          `Error: resume_agent message exceeds ${DEFAULT_MAX_ENTRY_CHARS} characters ` +
            `(got ${message.length}).`,
        );
      }
      const outcome = deps.sessions.resumeOne(target, message, {
        onStart: () => {
          deps.fleetRecords.register(target);
        },
        onReply: (reply) => {
          deps.sessions.complete(target, reply);
        },
        onFail: (err) => {
          deps.sessions.fail(target, err instanceof Error ? err.message : String(err));
        },
      });
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
    "'interrupted' so resume_agent can pick it back up with full prior context. " +
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
      const denied = gateTarget(deps, "interrupt_agent", target, call.id);
      if (denied !== undefined) return denied;
      const outcome = deps.sessions.interruptOne(target);
      if (!outcome.ok) {
        return lifecycleResult(
          call.id,
          `Error: cannot interrupt "${target}" (status: ${outcome.status}).`,
        );
      }
      return lifecycleResult(
        call.id,
        JSON.stringify({ agent_id: target, status: "interrupted" satisfies AgentLifecycleStatus }),
      );
    },
  });
}

const SendInputArgs = type({
  target: "string",
  message: "string",
  "interrupt?": "boolean",
});

export const sendInputToolDefinition: ToolDefinition = {
  name: "send_input",
  description:
    "Steer a running worker mid-turn. Soft (default): deliver `message` into the live session " +
    "and return immediately without awaiting a reply and without completing wait_agents. " +
    "With interrupt:true: stop the current turn (same wait-mailbox flip as interrupt_agent) " +
    "then queue `message` as the next-turn followup without awaiting that reply. Fails on a " +
    "session that is not currently running an active turn, or when the message is empty / oversize. Nested " +
    "orchestrators may only target their own descendants.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "agent_id of the running session to steer." },
      message: {
        type: "string",
        description: `Instruction to inject (non-empty, max ${DEFAULT_MAX_ENTRY_CHARS} characters).`,
      },
      interrupt: {
        type: "boolean",
        description:
          "When true, interrupt the current turn then queue message as the next-turn followup. " +
          "When false/omitted, soft-deliver into the running turn.",
      },
    },
    required: ["target", "message"],
  },
};

export function createSendInputTool(deps: LifecycleToolDeps): AgentTool {
  return tool({
    definition: sendInputToolDefinition,
    handler: async (call, _signal): Promise<ToolResult> => {
      const parsed = SendInputArgs(call.arguments);
      if (parsed instanceof type.errors) {
        return lifecycleResult(call.id, `Error: send_input arguments invalid: ${parsed.summary}`);
      }
      const target = parsed.target.trim();
      const denied = gateTarget(deps, "send_input", target, call.id);
      if (denied !== undefined) return denied;
      const message = parsed.message.trim();
      if (message.length === 0) {
        return lifecycleResult(call.id, "Error: send_input requires a non-empty message.");
      }
      if (message.length > DEFAULT_MAX_ENTRY_CHARS) {
        return lifecycleResult(
          call.id,
          `Error: send_input message exceeds ${DEFAULT_MAX_ENTRY_CHARS} characters ` +
            `(got ${message.length}).`,
        );
      }
      const interrupt = parsed.interrupt === true;
      const outcome = deps.sessions.sendInputOne(target, message, {
        ...(interrupt ? { interrupt: true } : {}),
        ...(interrupt && deps.fleetRecords !== undefined
          ? {
              onFollowupReply: (reply: string) => {
                deps.fleetRecords?.completeAfterInterrupt(target, reply);
              },
            }
          : {}),
      });
      if (!outcome.ok) {
        return lifecycleResult(
          call.id,
          `Error: cannot send_input to "${target}" (status: ${outcome.status}).`,
        );
      }
      if (interrupt) deps.fleetRecords?.interrupt(target);
      return lifecycleResult(call.id, JSON.stringify({ agent_id: target, status: outcome.status }));
    },
  });
}
