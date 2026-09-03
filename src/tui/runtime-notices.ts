/**
 * Runtime side-channel notices: lifecycle hooks, MCP connection state,
 * recorded permission grants, and successful context compaction.
 *
 * These channels are chatter by default and only sometimes news. The split
 * this module encodes:
 *
 * - a **row** is for something the operator has to act on, and that they must
 *   still be able to read after scrolling away (a hook that failed, an MCP
 *   server asking for authorization or refusing to connect);
 * - a **flash** is for confirmation of something they just caused, true only
 *   for a moment (a hook that ran, a server that came up, a grant recorded,
 *   a compaction that folded turns away);
 * - **null** is for inventory and intermediate states (`hooks.loaded`, a
 *   server that is merely `connecting`) — the /hooks and /mcp panels own that.
 *
 * Pure: strings only, no shell or renderer access.
 */

import { type } from "arktype";

import type { LifecycleHookEvent, LifecycleHookStatus } from "../session/hooks.js";
import type { MCPServerState } from "../agent/tools.js";
import type { Approval } from "../permission/types.js";

/** How a channel wants to be seen. `null` means it has nothing to say. */
export type RuntimeNotice =
  | { readonly kind: "row"; readonly text: string }
  | { readonly kind: "flash"; readonly text: string };

/** Lifetime of a confirmation flash. Long enough to read, short enough to leave. */
export const RUNTIME_FLASH_MS = 4000;

/** First non-empty stderr line, capped so a stack trace cannot own the row. */
function stderrSummary(stderr: string): string | null {
  const line = stderr
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line === undefined) return null;
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function hookFailure(hook: LifecycleHookStatus): string | null {
  const exit = hook.lastExitStatus;
  if (exit === undefined) return null;
  if (exit.signal !== null) return exit.signal;
  if (exit.code !== null && exit.code !== 0) return `exit ${exit.code}`;
  return null;
}

/**
 * Live per-turn hook status. A hook that fired and failed is the only thing
 * worth a row: it silently did not do its job, and the operator's way out is
 * to disable it.
 */
export function hookNotice(event: LifecycleHookEvent): RuntimeNotice | null {
  // Startup inventory, not a turn event — the /hooks panel already lists these.
  if (event.type !== "hook.updated") return null;
  const hook = event.hook;
  if (hook.lastFiredAt === undefined) return null;

  const failure = hookFailure(hook);
  if (failure === null) {
    return { kind: "flash", text: `hook ${hook.name} ran` };
  }
  const detail = stderrSummary(hook.lastExitStatus?.stderr ?? "");
  const cause = detail === null ? "" : `: ${detail}`;
  return {
    kind: "row",
    text: `hook ${hook.name} failed (${failure})${cause} — /hooks to disable it`,
  };
}

/**
 * MCP connection state. Reconnect chatter is noise on every server every run;
 * a server refusing to connect changes what the agent can do, so it keeps a
 * row. A server waiting on authorization is a standing condition with an
 * action attached, which is the prompt box's and /mcp's job, not a row's.
 */
export function mcpNotice(state: MCPServerState): RuntimeNotice | null {
  switch (state.state) {
    case "connecting":
      return null;
    case "connected": {
      const n = state.tools.length;
      return {
        kind: "flash",
        text: `mcp ${state.name} connected · ${n} tool${n === 1 ? "" : "s"}`,
      };
    }
    // A raw authorization URL in the transcript is unactionable and scrolls
    // away. The prompt box marks these and /mcp does the authorizing.
    case "needs-auth":
      return null;
    case "disconnected":
      return null;
    case "failed":
      return {
        kind: "row",
        text: `mcp ${state.name} did not connect (${state.error}) — its tools are unavailable; /mcp for detail`,
      };
  }
}

/** Confirmation that an approval was recorded, and where to take it back. */
export function grantNotice(approval: Approval): RuntimeNotice {
  return {
    kind: "flash",
    text: `granted ${approval.tool} ${approval.pattern} — /permissions to revoke`,
  };
}

export interface CompactionFoldInfo {
  readonly turnsBefore: number;
  readonly turnsAfter: number;
}

/** Confirmation that context compaction actually folded turns away. */
export function compactionNotice(info: CompactionFoldInfo): RuntimeNotice {
  return {
    kind: "flash",
    text: `context compacted · ${info.turnsBefore} → ${info.turnsAfter} turns`,
  };
}

// ---------------------------------------------------------------------------
// Emitter payload validation
// ---------------------------------------------------------------------------
//
// The emitter is untyped (`EventEmitter`), so every payload arrives as
// `unknown`. Each parser keeps only the fields the notices read; a payload
// that does not match is dropped rather than painted half-formed.

const hookExitStatus = type({
  code: "number | null",
  signal: "string | null",
  stderr: "string",
});

const hookUpdatedEvent = type({
  type: "'hook.updated'",
  hook: {
    id: "string",
    name: "string",
    type: "'typescript' | 'shell'",
    path: "string",
    enabled: "boolean",
    "lastFiredAt?": "number",
    "lastKind?": "'postTurn' | 'postRun'",
    "lastExitStatus?": hookExitStatus,
  },
});

export function lifecycleHookEvent(raw: unknown): LifecycleHookEvent | null {
  const parsed = hookUpdatedEvent(raw);
  if (parsed instanceof type.errors) return null;
  return { type: "hook.updated", hook: parsed.hook as LifecycleHookStatus };
}

const mcpState = type({ name: "string", state: "'connecting'" })
  .or({ name: "string", state: "'needs-auth'", url: "string" })
  .or({ name: "string", state: "'connected'", tools: "string[]" })
  .or({ name: "string", state: "'failed'", error: "string" })
  .or({ name: "string", state: "'disconnected'" });

export function mcpServerState(raw: unknown): MCPServerState | null {
  const parsed = mcpState(raw);
  if (parsed instanceof type.errors) return null;
  return parsed as MCPServerState;
}

const grantPayload = type({
  approval: {
    tool: "string",
    pattern: "string",
    "providerModel?": "string",
    "cwd?": "string",
  },
});

export function grantApproval(raw: unknown): Approval | null {
  const parsed = grantPayload(raw);
  if (parsed instanceof type.errors) return null;
  return parsed.approval as Approval;
}

const compactionPayload = type({
  turnsBefore: "number",
  turnsAfter: "number",
});

export function compactionFoldInfo(raw: unknown): CompactionFoldInfo | null {
  const parsed = compactionPayload(raw);
  if (parsed instanceof type.errors) return null;
  return parsed;
}

export interface SubAgentProgress {
  readonly description: string;
  readonly toolName: string;
}

const progressPayload = type({ description: "string", toolName: "string" });

export function subAgentProgress(raw: unknown): SubAgentProgress | null {
  const parsed = progressPayload(raw);
  if (parsed instanceof type.errors) return null;
  return parsed;
}
