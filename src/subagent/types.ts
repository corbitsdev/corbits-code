/**
 * Shared sub-agent types for run.ts and agent-fleet.ts, kept separate so
 * agent-fleet never imports run (ESM cycle).
 */

import type { AgentTool } from "@intx/agent";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { BlobReader, RetryPolicy } from "@intx/types/runtime";
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
import type { AdmissionQueue } from "./admission.js";
import type { SkillSummary } from "../extensions/skills.js";

export interface SubAgentProvider {
  providerName: string;
  baseURL: string;
  apiKey?: string;
  keyless?: boolean;
  model: string;
  // Resolved effort for this spawn (pin > explicit parent > role default >
  // derived parent). See resolveEffortForRole — leaves default to medium,
  // orchestrators to high; an operator-chosen (explicit) primary effort is a
  // fleet-wide pin and beats the role default.
  reasoningEffort?: ReasoningEffort;
  /**
   * Present (true) when `reasoningEffort` was operator-chosen (Config sent an
   * explicit reasoningEffort) rather than derived. A present marker is a
   * fleet-wide pin that outranks the role default; absent = role defaults
   * apply (CL-5162).
   */
  explicitReasoningEffort?: true;
  // Mirrors ProviderCatalogEntry.bifrostVirtualKey. Without it the dispatch
  // path builds a plain openai-compatible source and the gateway never
  // receives the x-bf-vk header.
  bifrostVirtualKey?: boolean;
}

// Dependencies an orchestrator sub-agent needs to spawn further workers via
// `spawn_agent`. Nested dispatch always sets allowOrchestrator: false so
// orchestration bottoms out at one hop.
export interface SubAgentSandboxDeps {
  permissionGate: PermissionGate;
  inheritMcpTools?: (gate: PermissionGate) => readonly AgentTool[];
  shellTimeout?: ShellTimeoutConfig;
  extraToolPlugins?: ToolPlugin[];
  /** Parent session blob store for bounded tool-output:// reads in workers. */
  getBlobReader?: () => BlobReader | undefined;
  /** Project settings.env, merged into the sub-agent's run_shell spawn environment. */
  shellEnv?: Record<string, string>;
  /**
   * Parent's secret-guard runtime denylist, so workers cannot silently use
   * skip-permissions the primary itself is denied. Inherited down the
   * dispatch chain.
   */
  secretGuardExtraDeniedPaths?: readonly string[];
  /** Plugin skill dirs, same list the primary passes to createUseSkillTool. */
  skillDirs?: readonly string[];
  /**
   * The dispatcher's already-discovered skill catalog; a lane cwd matching
   * the discovery cwd reuses it instead of rescanning. run.ts falls back
   * when unset or the worktree cwd differs.
   */
  skillSnapshot?: readonly SkillSummary[];
}

export type NestedDispatchDeps = SubAgentSandboxDeps & {
  getWorkdirBase: () => string;
  provider: SubAgentProvider | (() => SubAgentProvider);
  onEvent?: (event: ReactorEmittedEvent) => void;
  // Fired on each tool_call.end so the parent can surface live activity
  // without replaying the sub-agent event stream into the transcript.
  onProgress?: (info: { description: string; toolName: string }) => void;
  sessions?: SubAgentSessionStore;
  settings?: Settings | (() => Settings | undefined);
  catalog?:
    | readonly ProviderCatalogEntry[]
    | (() => readonly ProviderCatalogEntry[]);
  profiles?: AgentProfile[] | (() => AgentProfile[]);
  // The orchestrator's own session id, so workers it dispatches record as
  // nested (one-hop) sessions the Agents strip can indent under it.
  parentSessionId?: string;
  // Forwarded from the outer fleet deps so nested workers isolate their
  // worktree like their orchestrator.
  useWorktree?: boolean;
  /**
   * Nested `spawn_agent` may only spawn these director/profile ids;
   * omitted = no filter (primary). No closed director sets one today.
   */
  spawnAllowlist?: readonly string[];
  /** Same process admission queue as RunSubAgentParams.admission. */
  admission?: AdmissionQueue;
};

/** Typed spawn intent — optional on `spawn_agent`; omit Intent section when unset. */
export type RunSubAgentParams = {
  cwd: string;
  workdirBase: string;
  /**
   * Stable id for the worker's trace directory (subagents/<id>); must match
   * the store record id when tracked, so read_agent_trace reuses the
   * parentSessionId chain. Falls back to a fresh id when unset or unsafe.
   */
  id?: string;
  provider: SubAgentProvider;
  settings?: Settings;
  catalog?: readonly ProviderCatalogEntry[];
  description: string;
  context?: string;
  prompt: string;
  // Ordered goals for the worker to track; surfaced in the brief as a
  // manage_tasks seed — the child keeps its own list.
  goals?: readonly string[];
  /** Spawn intent for the brief; tool filtering is owned by the dispatcher. */
  intent?: TaskIntent;
  /** Concrete done checks preferred over free-form prompt alone. */
  successCriteria?: readonly string[];
  /** Explicit out-of-scope / forbidden actions. */
  doNot?: readonly string[];
  /** What the parent most needs in Findings. */
  reportFocus?: string;
  signal?: AbortSignal;
  /** Same process admission queue as spawn. Tests inject; worker 429 freeze uses this. */
  admission?: AdmissionQueue;
  /**
   * Override the outer provider-failure backoff. Tests inject a short delay
   * to skip the production 500ms wait.
   */
  outerRetryDelayMs?: number;
  /**
   * Override the per-attempt retry policy inside a live send. Tests inject
   * a fast policy to skip the production backoff.
   */
  retryPolicy?: RetryPolicy;
  onEvent?: (event: ReactorEmittedEvent) => void;
  onProgress?: (info: { description: string; toolName: string }) => void;
  onRunSettled?: (summary: Readonly<SubAgentRunSettlement>) => void;
  capabilities?: CapabilityFilter;
  /**
   * Canonical tool names this worker hard-requires. The dispatcher verifies
   * pre-spawn; run.ts re-checks after the capability filter, failing the
   * run as a stale snapshot on a miss.
   */
  requiresTools?: readonly string[];
  /**
   * Skill allowlist for the worker's skill_search + use_skill mounts, the
   * union of DirectorPackage.attachedSkills and optionalSkills. Set: tools
   * see only these names (unknown names refuse). Unset: every discovered
   * skill.
   */
  allowedSkillNames?: readonly string[];
  /**
   * Skill names whose bodies are injected into the worker system prompt at
   * spawn. Misses are noted in the prompt — never park or fail init.
   */
  attachedSkills?: readonly string[];
  /**
   * Plugin skill dirs from the primary (skillDirsFromEnabledPlugins), passed
   * to discoverSkills and createUseSkillTool so bundled corbits-skills
   * resolve as on the primary.
   */
  skillDirs?: readonly string[];
  /**
   * Pre-discovered skill catalog for this lane's cwd; skips the worker's
   * own discovery scan. Unset (or a worktree lane with a different cwd)
   * falls back to the parent's cached discovery.
   */
  skills?: readonly SkillSummary[];
  /**
   * Skip the worker's pricing-cache seed read; fleet workers reuse the
   * parent's process seed applied at boot.
   */
  skipPricingSeed?: boolean;
  systemPromptRole?: string;
  /** Resolved closed-director id (e.g. "reviewer"); structured gate key,
   * preferred over persona-string matching in systemPromptRole. */
  directorId?: string;
  // When true, the system prompt grants this sub-agent permission to call
  // `spawn_agent` (orchestrator exception to the no-recursion rule); set
  // only for built-in director packages. Requires nestedDispatch —
  // advertising permission without the tools is a hard break.
  orchestrator?: boolean;
  /**
   * Fleet authority tier for this dispatch (from DirectorPackage.tier).
   * Required when orchestrator is true: runSubAgent denies fleet tools when
   * this is undefined or "leaf". See authority.ts.
   */
  orchestratorTier?: SubagentTier;
  // Present only when orchestrator is true. Installs fleet tools so the
  // orchestrator can actually dispatch workers.
  nestedDispatch?: NestedDispatchDeps;
  /**
   * Optional wall-clock budget (ms) for the whole run; opt-in only — no
   * default leaf death clock. Omit to bound the run with operator cancel
   * alone.
   */
  deadlineMs?: number;
  /**
   * Resolved director tier, independent of `orchestratorTier`; runSubAgent
   * mounts `submit_result` only when this is `"leaf"`.
   */
  tier?: SubagentTier;
  /** DirectorPackage.reportContract.outputType, when the resolved leaf declares one. */
  reportType?: OutputType;
  /**
   * When true, a clean success skips end-of-turn teardown
   * (agent.close() / posixTools.dispose()) so the session stays open and
   * reusable; failures and aborts still tear down. The caller must
   * close_agent or it leaks its posix tools / workdir lock.
   */
  persist?: boolean;
  /**
   * Override the teardown deadline (ms) on the non-persist path. Tests
   * inject a short deadline so wedged-close suites skip the production 30s
   * bound.
   */
  teardownDeadlineMs?: number;
  /**
   * Narrow session-store port for leaf `ask_director`; the store owns the
   * pending Promise, this run only registers and awaits. Omit when the
   * caller has no mailbox (tests, non-fleet dispatches).
   */
  askDirectorPort?: {
    register: (input: {
      question: string;
      questionId: string;
      grantRequestId?: string;
    }) => Promise<string>;
    cancel: (reason: string) => void;
  };
  /**
   * Fired once the agent object exists (before the prompt is sent), with
   * handles for this session:
   *
   *  - `close`: bounded teardown for close_agent.
   *  - `interrupt`: stops the in-flight `agent.send()` via a signal scoped
   *    to that call only; the reactor keeps running, the caller stops
   *    waiting.
   *  - `followup`: sends a new message into the same live agent once the
   *    current turn is inactive — what `resume_agent` builds on.
   *
   * Always fired regardless of `persist`; a wedged close fails rather than
   * reporting success while children are live.
   */
  onAgentReady?: (handles: {
    close: (deadlineMs?: number) => Promise<void>;
    interrupt: () => void;
    followup: (message: string) => Promise<string>;
    deliver: (message: string) => void;
  }) => void;
} & SubAgentSandboxDeps;

/** runSubAgent's result: the parent-facing report plus, when force-stopped,
 * the structured reason why — classify outcomes from `stopReason`, not by
 * parsing `report`. */
export interface SubAgentTelemetryRollup {
  turn_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  tool_call_count: number;
  tool_error_count: number;
}

export type SubAgentTerminalReason = ForcedStopReason | "complete" | "error";

export interface SubAgentRunSettlement extends SubAgentTelemetryRollup {
  error_count: number;
  duration_ms: number;
  model: string;
  terminal_reason: SubAgentTerminalReason;
}

export interface RunSubAgentResult {
  report: string;
  stopReason?: ForcedStopReason;
  /**
   * True only when `persist: true` skipped teardown on clean completion. A
   * deadline/cancel salvage always disposes its agent, so this stays falsy
   * there — the store keeps a disposed salvage from looking resumable.
   */
  agentRetained?: boolean;
  /**
   * True only when interrupt_agent ended the run. The session is already
   * "interrupted", so the caller must skip its normal complete()/fail()
   * bookkeeping.
   */
  interrupted?: boolean;
  /**
   * Counts accumulated during the run for ambient `subagent_end` telemetry.
   * Never includes prompts, paths, or free-text ids.
   */
  telemetry?: SubAgentTelemetryRollup;
}
