/**
 * Shared sub-agent types used by both run.ts and task-tool.ts.
 * Kept separate so task-tool does not import run (breaks the ESM cycle).
 */

import type { AgentTool } from "@intx/agent";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { BlobReader } from "@intx/types/runtime";
import type { ToolPlugin } from "@intx/tools-posix";

import type { CapabilityFilter, AgentProfile } from "../agent/profiles.js";
import type { ProviderCatalogEntry } from "../config/index.js";
import type { OutputType } from "./submit-result.js";
import type { Settings } from "../config/settings.js";
import type { ShellTimeoutConfig } from "../plugins/shell-guard-plugin.js";
import type { PermissionGate } from "../permission/gate.js";
import type { ReasoningEffort } from "../provider/reasoning-effort.js";
import type { SubAgentSessionStore } from "./session-store.js";
import type { TaskIntent } from "./report.js";
import type { SubagentTier } from "../agent/directors/types.js";
import type { ForcedStopReason } from "./stop-policy.js";

export interface SubAgentProvider {
  providerName: string;
  baseURL: string;
  apiKey?: string;
  keyless?: boolean;
  model: string;
  // Resolved effort for this spawn (pin > role default > parent). See
  // resolveEffortForRole — leaves default to medium, orchestrators to high,
  // so a primary /agent high selection does not force every leaf onto high.
  reasoningEffort?: ReasoningEffort;
  // Mirrors ProviderCatalogEntry.bifrostVirtualKey. Without it the dispatch
  // path builds a plain openai-compatible source and the gateway never
  // receives the x-bf-vk header.
  bifrostVirtualKey?: boolean;
}

// Dependencies an orchestrator sub-agent needs to spawn further workers via
// `task`. Nested dispatch always sets allowOrchestrator: false so the
// recursion bottoms out at one hop of orchestration.
export interface SubAgentSandboxDeps {
  permissionGate: PermissionGate;
  inheritMcpTools?: () => readonly AgentTool[];
  shellTimeout?: ShellTimeoutConfig;
  extraToolPlugins?: ToolPlugin[];
  /** Parent session blob store for bounded tool-output:// reads in workers. */
  getBlobReader?: () => BlobReader | undefined;
  /** Project settings.env, merged into the sub-agent's run_shell spawn environment. */
  shellEnv?: Record<string, string>;
}

export type NestedDispatchDeps = SubAgentSandboxDeps & {
  getWorkdirBase: () => string;
  provider: SubAgentProvider | (() => SubAgentProvider);
  onEvent?: (event: ReactorEmittedEvent) => void;
  // Fired on each tool_call.end so the parent can surface live activity without
  // replaying the full sub-agent event stream into the chat transcript.
  onProgress?: (info: { description: string; toolName: string }) => void;
  sessions?: SubAgentSessionStore;
  settings?: Settings | (() => Settings | undefined);
  catalog?: readonly ProviderCatalogEntry[] | (() => readonly ProviderCatalogEntry[]);
  profiles?: AgentProfile[] | (() => AgentProfile[]);
  // The orchestrator's own session id, so workers it dispatches record as
  // nested (one-hop) sessions the Agents strip can indent under it.
  parentSessionId?: string;
  // Forwarded from the outer TaskToolDeps so nested workers get the same
  // worktree-isolation behavior as their orchestrator.
  useWorktree?: boolean;
  /**
   * When set (e.g. greybeard → intern/explore/critique), nested `task` may only
   * spawn these director/profile ids. Omitted = no allowlist filter (primary).
   */
  spawnAllowlist?: readonly string[];
};

/** Typed spawn intent — optional on `task`; omit Intent section when unset. */
export type RunSubAgentParams = {
  cwd: string;
  workdirBase: string;
  /**
   * Stable id for this worker's on-disk trace directory (subagents/<id>).
   * Callers that track a session store (task-tool.ts) pass the same id as
   * the SubAgentSessionStore record so read_agent_trace's descendant check
   * can reuse the store's existing parentSessionId chain instead of a
   * second identity scheme. Falls back to a fresh generated id when unset
   * or unsafe for a path segment.
   */
  id?: string;
  provider: SubAgentProvider;
  settings?: Settings;
  catalog?: readonly ProviderCatalogEntry[];
  description: string;
  context?: string;
  prompt: string;
  // Optional ordered goals the parent wants the worker to track. Surfaced in
  // the dispatch brief as a suggested manage_tasks seed — the child's list is
  // still its own; the parent does not share a checklist.
  goals?: readonly string[];
  /** Spawn intent for the brief (no tool filtering here — that is a later task). */
  intent?: TaskIntent;
  /** Concrete done checks preferred over free-form prompt alone. */
  successCriteria?: readonly string[];
  /** Explicit out-of-scope / forbidden actions. */
  doNot?: readonly string[];
  /** What the parent most needs in Findings. */
  reportFocus?: string;
  signal?: AbortSignal;
  onEvent?: (event: ReactorEmittedEvent) => void;
  onProgress?: (info: { description: string; toolName: string }) => void;
  capabilities?: CapabilityFilter;
  systemPromptRole?: string;
  /** Resolved closed-director id (e.g. "critique") when the worker is one. Structured gate key — prefer over persona-string matching in systemPromptRole. */
  directorId?: string;
  // When true, the assembled system prompt grants this sub-agent permission
  // to call `task` to spawn further agents (orchestrator exception to the
  // no-recursion rule). Set from AgentProfile.orchestrator at dispatch time.
  // Requires nestedDispatch so the task tool can actually be installed —
  // advertising permission without the tool is a hard break.
  orchestrator?: boolean;
  /**
   * Fleet authority tier for this dispatch, resolved by the caller
   * (task-tool.ts) from either the closed DirectorPackage.tier or an explicit
   * AgentProfile.tier opt-in. Required whenever orchestrator is true:
   * runSubAgent fails closed (denies task/search_agents) when orchestrator is
   * true and this is undefined or "leaf" — an unrecognized or unresolved tier
   * must never mount a fleet verb. See src/subagent/authority.ts.
   */
  orchestratorTier?: SubagentTier;
  // Present only when orchestrator is true. Installs task + search_agents so
  // the orchestrator can actually dispatch workers.
  nestedDispatch?: NestedDispatchDeps;
  /**
   * Optional wall-clock budget for this worker's whole run (ms). Opt-in only —
   * there is no default leaf death clock; omit to bound the run with
   * operator cancel alone.
   */
  deadlineMs?: number;
  /**
   * Resolved director tier, independent of `orchestratorTier` (which
   * is only ever set when `orchestrator` is true). Set by task-tool.ts from
   * `DirectorPackage.tier`. runSubAgent mounts `submit_result` only when this
   * is `"leaf"` — the existing tier machinery (authority.ts / directors/types.ts)
   * gates it, not a new mechanism.
   */
  tier?: SubagentTier;
  /** DirectorPackage.reportContract.outputType, when the resolved leaf declares one. */
  reportType?: OutputType;
  /**
   * when true, a clean successful completion skips the normal
   * end-of-turn teardown (agent.close() / posixTools.dispose()) so the
   * session stays open and reusable. A failure or an aborted/cancelled run
   * still tears down as before — only a clean success is retained. A caller
   * that opts in must eventually close the session (close_agent) or it
   * leaks its posix tools / workdir lock.
   */
  persist?: boolean;
  /**
   * Fired once the underlying agent object exists (before the prompt is
   * sent), with handles the caller can register for later use against this
   * session:
   *
   *  - `close`: bounded teardown for close_agent.
   *  - `interrupt`: stops the in-flight `agent.send()` by firing a signal
   *    scoped to that call only — distinct from `close`'s
   *    AbortController, so firing it never touches agent.close() or the
   *    workdir lock. The reactor cycle itself keeps running in the
   *    background (same documented behavior as `Agent.send`'s own
   *    `signal` option); this only stops the caller from waiting on it.
   *  - `followup`: sends a new message into the same live agent (same
   *    history, same context store) once the current turn is no longer
   *    active — this is the resume mechanism `resume_agent`/`followup_task`
   *    build on, reusing `agent.send`'s own FIFO send-queue ordering rather
   *    than a second continuation scheme.
   *  - `deliver`: durable mid-run injection via `agent.deliver` (not
   *    ephemeralTurns) so `send_input` can soft-steer a running worker
   *    without awaiting a reply.
   *
   * Always fired regardless of `persist`, so a caller can act on a
   * still-running session too, not only a retained one. The deadline
   * argument to `close` bounds how long teardown may take; a wedged close is
   * abandoned (not awaited further) once it elapses rather than hanging the
   * caller.
   */
  onAgentReady?: (handles: {
    close: (deadlineMs?: number) => Promise<void>;
    interrupt: () => void;
    followup: (message: string) => Promise<string>;
    deliver: (message: string) => void;
  }) => void;
} & SubAgentSandboxDeps;

/** runSubAgent's result: the parent-facing report plus, when force-stopped, the structured reason why — classify outcomes from `stopReason`, not by parsing `report`. */
export interface RunSubAgentResult {
  report: string;
  stopReason?: ForcedStopReason;
  /**
   * true only on the clean-completion path when `persist: true`
   * actually skipped teardown (mirrors run.ts's own turnSucceeded gate). A
   * deadline/cancel salvage returns without throwing but always disposes its
   * agent, so this is absent (falsy) there even though the promise resolves
   * the same way a clean completion does — the session store uses this to
   * keep a disposed salvage from ever looking resumable.
   */
  agentRetained?: boolean;
  /**
   * true only when this run ended because interrupt_agent fired
   * (not a plain cancel/deadline) — the caller must not run its normal
   * complete()/fail() bookkeeping over this result, since interrupt_agent
   * already transitioned the session to "interrupted" synchronously.
   */
  interrupted?: boolean;
}
