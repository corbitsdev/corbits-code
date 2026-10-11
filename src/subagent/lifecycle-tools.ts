/**
 * close_agent / resume_agent: the session-lifecycle half of
 * reusable worker sessions. spawn_agent/wait_agents start and
 * collect workers; these two verbs let an orchestrator tear one down on
 * purpose (close_agent) or start the next turn on a retained completed
 * or interrupted session (resume_agent), returning immediately so
 * wait_agents collects. send_input steers an in-flight running turn, or
 * answers a pending ask_director (soft; does not deliver a steer inbound).
 */

import { tool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import { type } from "arktype";
import type { ToolDefinition, ToolResult } from "@intx/types/runtime";

import { DEFAULT_CLOSE_DEADLINE_MS } from "./dispose.js";
import { errorMessage } from "../agent/error-message.js";
import type { FleetMailboxHandle } from "./agent-fleet.js";
import {
  fleetDrySpillKey,
  MAILBOX_DIGEST_SECTION_CHARS,
  UNSTRUCTURED_DIGEST_CHARS,
} from "./fleet-dry-drive.js";
import { parseSubAgentReport } from "./report.js";
import {
  DEFAULT_MAX_ENTRY_CHARS,
  type AgentLifecycleStatus,
  type SubAgentSessionStore,
} from "./session-store.js";
import { parseEscalationResolution } from "./escalation-policy.js";
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

function fleetJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const CloseAgentArgs = type({
  target: "string",
});

export const closeAgentToolDefinition: ToolDefinition = {
  name: "close_agent",
  description:
    "Permanently close a worker and its descendants. Cannot be resumed.",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "agent_id.",
      },
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
    "Send the next turn to a completed or interrupted worker, keeping its context. Returns at once; collect the reply as usual.",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "agent_id.",
      },
      message: {
        type: "string",
        description: "Instruction.",
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

/** interrupt_agent stamps session interrupted and flips the wait mailbox overlay. */
export type InterruptAgentToolDeps = LifecycleToolDeps & {
  fleetRecords: FleetMailboxHandle;
};

/** resume_agent registers the next turn on the wait mailbox so wait_agents can collect. */
export type ResumeAgentToolDeps = LifecycleToolDeps & {
  fleetRecords: FleetMailboxHandle;
};

/**
 * Clip a late-send summary the same way digestCollectedReport clips its inline
 * digest section: structured reports keep up to MAILBOX_DIGEST_SECTION_CHARS,
 * unstructured (no envelope sections) keep a short teaser — the blob holds
 * the rest.
 */
function clipLateSendSummary(text: string, unstructured: boolean): string {
  const max = unstructured
    ? UNSTRUCTURED_DIGEST_CHARS
    : MAILBOX_DIGEST_SECTION_CHARS;
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Late-send_input redirect per terminal status. Only `completed` delivered a
 * report (via mailbox mail); `interrupted` never did, and `shutdown` sessions
 * are gone for good (resumeOne after closeOne fails), so only `completed`
 * names resume_agent. Shutdown/evicted point at read_agent_trace / a fresh
 * spawn instead.
 */
function lateSendRedirect(
  target: string,
  status: AgentLifecycleStatus,
  gone: boolean,
  report: string | undefined,
): string {
  if (status === "completed" && !gone) {
    let digest = "";
    if (report !== undefined && report.length > 0) {
      const parsed = parseSubAgentReport(report);
      const unstructured =
        parsed.findings.length === 0 &&
        parsed.blockers.length === 0 &&
        parsed.paths.length === 0;
      const summary =
        parsed.summary.length > 0
          ? clipLateSendSummary(parsed.summary, unstructured)
          : "";
      const reportUri = `tool-output:///${fleetDrySpillKey(target, "report")}`;
      digest =
        summary.length > 0
          ? ` Summary: ${summary} report_uri: ${reportUri} — use read_file with that URI (offset/limit supported) to see the rest.`
          : ` report_uri: ${reportUri} — use read_file with that URI (offset/limit supported) to see the rest.`;
    }
    return (
      " Worker already finished (completed) — summary below; full report via " +
      "report_uri / mailbox mail; use resume_agent for another turn, do not retry send_input." +
      digest
    );
  }
  if (status === "interrupted" && !gone) {
    return (
      " Worker is interrupted (no report delivered) — " +
      "use resume_agent for another turn, do not retry send_input."
    );
  }
  if (status === "shutdown" || gone) {
    return (
      " Worker is shut down — the session is gone and cannot be resumed; " +
      "inspect via read_agent_trace or spawn a new worker, " +
      "do not use resume_agent or retry send_input."
    );
  }
  return "";
}

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
        return lifecycleResult(
          call.id,
          `Error: close_agent arguments invalid: ${parsed.summary}`,
        );
      }
      const target = parsed.target.trim();
      const denied = gateTarget(deps, "close_agent", target, call.id);
      if (denied !== undefined) return denied;
      if (deps.sessions.get(target) === undefined) {
        return lifecycleResult(
          call.id,
          fleetJson({
            agent_id: target,
            status: "not_found" satisfies AgentLifecycleStatus,
          }),
        );
      }
      const nodes = deps.sessions
        .list()
        .map((s) => ({ id: s.id, parentSessionId: s.parentSessionId }));
      const order = descendantsClosingOrder(nodes, target);
      const closed: { agent_id: string; status: AgentLifecycleStatus }[] = [];
      const failures: unknown[] = [];
      for (const id of order) {
        // Terminalize the wait mailbox before teardown. closeOne flips strip
        // status to "cancelled", which kills the soft-interrupt fallback that
        // still requires status === "running" — without this, in-flight
        // wait_agents hangs until timeout.
        deps.fleetRecords.interrupt(id);
        try {
          const status = await deps.sessions.closeOne(
            id,
            DEFAULT_CLOSE_DEADLINE_MS,
          );
          closed.push({ agent_id: id, status });
        } catch (err: unknown) {
          failures.push(err);
          const after = deps.sessions.get(id);
          closed.push({
            agent_id: id,
            status: after === undefined ? "not_found" : after.lifecycleStatus,
          });
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "close_agent leftover dispose failed",
        );
      }
      const own = closed.find((c) => c.agent_id === target);
      return lifecycleResult(
        call.id,
        fleetJson({
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
        return lifecycleResult(
          call.id,
          `Error: resume_agent arguments invalid: ${parsed.summary}`,
        );
      }
      const target = parsed.target.trim();
      const denied = gateTarget(deps, "resume_agent", target, call.id);
      if (denied !== undefined) return denied;
      const message = parsed.message.trim();
      if (message.length === 0) {
        return lifecycleResult(
          call.id,
          "Error: resume_agent requires a non-empty message.",
        );
      }
      if (message.length > DEFAULT_MAX_ENTRY_CHARS) {
        return lifecycleResult(
          call.id,
          `Error: resume_agent message exceeds ${DEFAULT_MAX_ENTRY_CHARS} characters ` +
            `(got ${message.length}).`,
        );
      }
      if (deps.fleetRecords.hasUncollectedTerminal(target)) {
        return lifecycleResult(
          call.id,
          `Error: cannot resume "${target}" before its prior result is collected. Call wait_agents for this agent_id first.`,
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
          deps.sessions.fail(target, errorMessage(err));
        },
      });
      if (!outcome.ok) {
        const hint = outcome.hint !== undefined ? ` ${outcome.hint}` : "";
        return lifecycleResult(
          call.id,
          `Error: cannot resume "${target}" (status: ${outcome.status}).${hint}`,
        );
      }
      if (outcome.status === "queued") {
        deps.fleetRecords.register(target);
        deps.fleetRecords.markQueued(target);
      }
      return lifecycleResult(
        call.id,
        fleetJson({ agent_id: target, status: outcome.status }),
      );
    },
  });
}

const InterruptAgentArgs = type({
  target: "string",
});

export const interruptAgentToolDefinition: ToolDefinition = {
  name: "interrupt_agent",
  description:
    "Stop a worker's current turn; session stays resumable via resume_agent (close_agent is permanent).",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "agent_id.",
      },
    },
    required: ["target"],
  },
};

export function createInterruptAgentTool(
  deps: InterruptAgentToolDeps,
): AgentTool {
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
      // Soft interrupt leaves the run in flight; projectWaitStatus treats
      // interrupted+inFlight as running so resume cannot collect a stale stamp.
      // Flip the wait mailbox overlay so in-flight wait_agents unblocks as interrupted.
      deps.fleetRecords.interrupt(target);
      return lifecycleResult(
        call.id,
        fleetJson({
          agent_id: target,
          status: "interrupted" satisfies AgentLifecycleStatus,
        }),
      );
    },
  });
}

const SendInputArgs = type({
  target: "string",
  message: "string",
  "interrupt?": "boolean",
  "resolution?": "unknown",
});

export const sendInputToolDefinition: ToolDefinition = {
  name: "send_input",
  description:
    "Message a running worker only (check list_agents for status) — completed or interrupted workers need resume_agent instead; shutdown workers are gone (see read_agent_trace or spawn anew). Answers a pending ask_director; interrupt:true stops the current turn first and queues message as the next turn.",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "agent_id.",
      },
      message: {
        type: "string",
        description: "Message.",
      },
      interrupt: {
        type: "boolean",
        description: "Interrupt first.",
      },
      resolution: {
        type: "object",
        description:
          "Optional explicit pending-escalation resolution (questionId, kind, answer). It never grants or retries a tool. The message is delivered together with the structured answer.",
        properties: {
          questionId: {
            type: "string",
            description: "The pending question id this resolution answers.",
          },
          kind: {
            type: "string",
            enum: [
              "director_answer",
              "declined",
              "unavailable",
              "minimum_grant_available",
            ],
            description:
              "director_answer (normal answer), declined, unavailable, or minimum_grant_available.",
          },
          answer: {
            type: "string",
            description: "Text the worker receives.",
          },
        },
        required: ["questionId", "kind", "answer"],
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
        return lifecycleResult(
          call.id,
          `Error: send_input arguments invalid: ${parsed.summary}`,
        );
      }
      const target = parsed.target.trim();
      const denied = gateTarget(deps, "send_input", target, call.id);
      if (denied !== undefined) return denied;
      const message = parsed.message.trim();
      if (message.length === 0) {
        return lifecycleResult(
          call.id,
          "Error: send_input requires a non-empty message.",
        );
      }
      if (message.length > DEFAULT_MAX_ENTRY_CHARS) {
        return lifecycleResult(
          call.id,
          `Error: send_input message exceeds ${DEFAULT_MAX_ENTRY_CHARS} characters ` +
            `(got ${message.length}).`,
        );
      }
      if (parsed.resolution !== undefined) {
        if (parsed.interrupt === true) {
          return lifecycleResult(
            call.id,
            "Error: structured escalation resolution cannot interrupt a worker.",
          );
        }
        const resolution = parseEscalationResolution(parsed.resolution);
        if (resolution instanceof Error) {
          return lifecycleResult(
            call.id,
            `Error: send_input resolution invalid: ${resolution.message}`,
          );
        }
        const pending = deps.sessions.peekAsk(target);
        if (pending === undefined) {
          return lifecycleResult(
            call.id,
            `Error: no pending escalation for "${target}".`,
          );
        }
        if (pending.questionId !== resolution.questionId) {
          return lifecycleResult(
            call.id,
            `Error: send_input resolution questionId mismatch: pending ask is "${pending.questionId}", resolution names "${resolution.questionId}".`,
          );
        }
        // SF6: deliver the parent's message together with the structured
        // answer so a resolution can never silently drop the message.
        if (!deps.sessions.resolveEscalationAsk(target, resolution, message)) {
          return lifecycleResult(
            call.id,
            `Error: no pending escalation for "${target}".`,
          );
        }
        return lifecycleResult(
          call.id,
          fleetJson({
            agent_id: target,
            status: "running",
            resolution: resolution.kind,
          }),
        );
      }
      const interrupt = parsed.interrupt === true;
      const outcome = deps.sessions.sendInputOne(target, message, {
        ...(interrupt ? { interrupt: true } : {}),
        ...(interrupt && deps.fleetRecords !== undefined
          ? {
              onStart: () => {
                deps.fleetRecords?.clearQueued(target);
              },
              onFollowupReply: (reply: string) => {
                deps.fleetRecords?.completeAfterInterrupt(target, reply);
              },
              onFail: () => {
                deps.fleetRecords?.completeAfterInterrupt(target);
              },
            }
          : {}),
      });
      if (!outcome.ok) {
        // CL-8016: name the teardown when one is recorded — after a stop the
        // session is gone, and a bare status would read as "never existed".
        // Late-send redirect is scoped per terminal status: only `completed`
        // delivered a report (summary + report_uri below, resume for more);
        // `interrupted` never delivered one; `shutdown`/evicted sessions are
        // gone for good, so they point at read_agent_trace / a fresh spawn.
        const session = deps.sessions.get(target);
        const redirect = lateSendRedirect(
          target,
          outcome.status,
          session === undefined && outcome.status !== "not_found",
          session?.report,
        );
        const hint = outcome.hint !== undefined ? ` ${outcome.hint}` : "";
        return lifecycleResult(
          call.id,
          `Error: cannot send_input to "${target}" (status: ${outcome.status}).${hint}${redirect}`,
        );
      }
      // CL-7331: an interrupt-with-followup is transitional, not terminal.
      // interrupt_agent/close_agent flip the wait mailbox so an in-flight
      // wait_agents unblocks as interrupted; a queued followup must instead
      // stay wait-live (running/queued) so the followup reply surfaces via
      // wait_agents instead of freezing as an already-collected interrupt.
      if (
        interrupt &&
        outcome.status === "interrupted" &&
        deps.fleetRecords !== undefined
      ) {
        deps.fleetRecords.noteFollowup(target);
        const after = deps.sessions.get(target);
        if (after?.lifecycle.state === "pending_init")
          deps.fleetRecords.markQueued(target);
      }
      return lifecycleResult(
        call.id,
        fleetJson({ agent_id: target, status: outcome.status }),
      );
    },
  });
}
