/**
 * spawn_agent / wait_agents: the split fleet dispatch surface.
 *
 * These two verbs are the supported fleet path: start several workers in one
 * turn (spawn_agent returns immediately) and later block on this caller's
 * own workers (wait_agents).
 *
 * Running state is the session store's `WorkerLifecycle`. wait_agents blocks
 * on that store's `subscribe` raced against a timeout timer, never polling.
 * Wait JSON is a projection of stored lifecycle plus a per-install wait
 * mailbox (`FleetMailbox`): membership, pin, collected, and an optional
 * wait-status override. Spawn/resume settlement writes only the session store.
 *
 * The store's finished-session retention is a TUI display cap (`maxCompleted`,
 * default 20): `complete()`/`fail()` evict the oldest finished session —
 * report and all — once more than that many have finished. A caller can spawn
 * far more workers than the cap in one turn and only
 * `wait_agents` them later, so an evicted report would otherwise vanish
 * silently. Mailbox `register` pins the session (honored by pruneCompleted
 * and pruneRetained) until collect unpins. Heavy payloads are still capped at
 * `MAX_FLEET_RECORDS`: past that, the oldest never-collected pin is compacted
 * to a tombstone (status only, plus a pointer at `read_agent_trace`).
 *
 * Argument shape includes description/prompt/context/goals/intent/
 * success_criteria/do_not/report_focus. Dispatch supports both closed
 * directors and local/plugin AgentProfile ids returned by search_agents.
 * Implement/review (and their default directors) fail closed without
 * non-empty success_criteria.
 *
 */

import { join } from "node:path";

import { tool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import { type } from "arktype";
import type { ToolDefinition, ToolResult } from "@intx/types/runtime";
import type { ReactorEmittedEvent } from "@intx/inference";
import { getLogger } from "@intx/log";

import { LOG_NAMESPACE_ROOT } from "../branding.js";
import { runtimeSettingsWithCatalog, type ProviderCatalogEntry } from "../config/index.js";
import { generateSessionId } from "../session/index.js";
import {
  INTENT_DEFAULT_DIRECTOR,
  isDirectorId,
  packageToCapabilities,
  resolveDirector,
} from "../agent/directors/registry.js";
import {
  defaultEffortForDirector,
  formatDirectorSystemPrompt,
} from "../agent/directors/identity.js";
import type { Settings } from "../config/settings.js";
import { resolveInferenceWithPolicy } from "../config/settings.js";
import {
  resolveEffortForRole,
  validateEffort,
  type ReasoningEffort,
} from "../provider/reasoning-effort.js";
import type { AgentProfile, CapabilityFilter } from "../agent/profiles.js";
import { isCodexProviderName } from "../config/codex-providers.js";
import { buildDispatchBrief, type TaskIntent } from "./report.js";
import {
  DEFAULT_CANCEL_REASON,
  type AgentLifecycleStatus,
  type SubAgentSessionStore,
} from "./session-store.js";
import { isLiveWaitStatus, projectWaitStatus, type WaitJSONStatus } from "./lifecycle.js";
import { getProcessAdmissionQueue, type AdmissionQueue } from "./admission.js";
import type {
  NestedDispatchDeps,
  RunSubAgentParams,
  RunSubAgentResult,
  SubAgentProvider,
  SubAgentSandboxDeps,
  SubAgentRunSettlement,
} from "./types.js";
import { cleanupSubAgentWorktree, createSubAgentWorktree, WorktreeError } from "./worktree.js";
import { NOOP_TELEMETRY, type Telemetry } from "../telemetry/index.js";
import { classifyAgentName } from "../telemetry/classify.js";
import { captureSubagentEnd } from "../telemetry/product-events.js";
import { getCurrentTurnTraceId } from "../telemetry/feedback.js";
import type { DirectorPackage } from "../agent/directors/types.js";
import { SPAWN_AGENT_TOOL_NAME } from "./tool-taxonomy.js";
import {
  assertCanTargetAgent,
  FleetAuthorityError,
  type FleetNode,
  type SubagentTier,
} from "./authority.js";

import { formatSubAgentSpawnAuthFailureMessage } from "./inference-auth-failure.js";
import { isResolvedProviderFailureError } from "../inference-error-message.js";
import { isSubAgentCancelError } from "./dispose.js";
import { createInterventionLog, type InterventionSink } from "./intervention-log.js";

const log = getLogger([LOG_NAMESPACE_ROOT, "subagent", "agent-fleet"]);

/** Wait JSON projection for one spawned agent, keyed by agent id. */
interface FleetRecord {
  status: WaitJSONStatus;
  report?: string;
  error?: string;
  providerFailure?: true;
  /** Set once a wait_agents caller has been handed this result. */
  collected?: boolean;
  /** Set once the payload has been compacted away to bound memory. */
  tombstoned?: boolean;
  /** Present only on a tombstoned record — how to recover the detail. */
  hint?: string;
  question?: string;
  questionId?: string;
  description?: string;
}

/** Per-install overlay: membership, pin, collected, optional wait override. */
interface FleetOverlay {
  collected?: boolean;
  pinHeld?: boolean;
  /** send_input interrupt:true / close_agent — wait interrupted while session may still be running. */
  forceInterrupted?: boolean;
  /** Admission overlay: wait JSON `queued` while run() has not been admitted. */
  forceQueued?: boolean;
  /** Frozen wait status after collect. Later session completed must not resurrect this mailbox. */
  frozenStatus?: WaitJSONStatus;
  /** Last wait projection seen while the session still existed. */
  lastWaitStatus?: WaitJSONStatus;
  tombstoned?: boolean;
  hint?: string;
  providerFailure?: true;
}

const RECOVERY_HINT =
  "Report evicted to bound fleet memory; recover full detail via read_agent_trace(agent_id).";

function waitStatusFromVerbLifecycle(
  status: AgentLifecycleStatus | undefined,
): WaitJSONStatus | undefined {
  if (status === "completed") return "done";
  if (status === "interrupted" || status === "shutdown") return "interrupted";
  return undefined;
}

/** Payload cap: uncollected pinned terminal records still holding a report. */
export const MAX_FLEET_RECORDS = 200;

/**
 * Per-install wait mailbox over the session store. Session lifecycle is the
 * source of wait status unless this overlay forces interrupted or has frozen
 * a collected result. See the module doc for pin/tombstone policy.
 */
class FleetMailbox {
  private readonly records = new Map<string, FleetOverlay>();
  private readonly sessions: SubAgentSessionStore;

  constructor(sessions: SubAgentSessionStore) {
    this.sessions = sessions;
    sessions?.subscribe(() => {
      this.rememberLiveWaitStatuses();
      this.enforceCap();
    });
  }

  register(id: string): void {
    const existing = this.records.get(id);
    // start() drops pinCounts on call-id reuse. Re-pin whenever the overlay
    // thought it still held a pin, so wait cannot desync against an empty map.
    if (existing?.pinHeld === true) this.sessions.unpin(id);
    const wait = this.sessionWaitStatus(id);
    this.records.set(id, {
      pinHeld: true,
      ...(wait !== undefined ? { lastWaitStatus: wait } : {}),
    });
    this.sessions.pin(id);
    this.enforceCap();
  }

  hasUncollectedTerminal(id: string): boolean {
    const record = this.peek(id);
    return record !== undefined && !isLiveWaitStatus(record.status) && record.collected !== true;
  }

  markProviderFailure(id: string): void {
    const existing = this.records.get(id);
    if (existing === undefined) return;
    existing.providerFailure = true;
  }

  markQueued(id: string): void {
    const existing = this.records.get(id);
    if (existing === undefined || existing.collected === true) return;
    existing.forceQueued = true;
    this.sessions?.wake();
  }

  clearQueued(id: string): void {
    const existing = this.records.get(id);
    if (existing === undefined || existing.forceQueued !== true) return;
    delete existing.forceQueued;
    this.sessions?.wake();
  }

  /**
   * Overlay wait-status override so wait unblocks while the session may still
   * be running (send_input interrupt:true followup, close_agent teardown).
   * No-op on an already-collected mailbox — frozen status stays interrupted.
   */
  interrupt(id: string, _report?: string): void {
    const existing = this.records.get(id);
    if (existing === undefined) return;
    if (existing.collected === true) {
      this.sessions?.wake();
      return;
    }
    existing.forceInterrupted = true;
    delete existing.forceQueued;
    this.sessions?.wake();
    this.enforceCap();
  }

  /**
   * send_input interrupt:true followup finished. Clear an uncollected
   * interrupted overlay so wait projects session completed → done. No-op if
   * wait_agents already collected the interrupt.
   */
  completeAfterInterrupt(id: string, _report?: string): void {
    const existing = this.records.get(id);
    if (existing === undefined || existing.collected === true) return;
    if (existing.forceInterrupted !== true) return;
    delete existing.forceInterrupted;
    this.sessions?.wake();
  }

  ids(): string[] {
    return [...this.records.keys()];
  }

  /** Running plus terminal-but-not-yet-handed-to-a-waiter. */
  uncollectedIds(): string[] {
    return [...this.records.entries()]
      .filter(([, record]) => record.collected !== true)
      .map(([id]) => id);
  }

  /** Read without consuming — used for the terminal-yet check. */
  peek(id: string): FleetRecord | undefined {
    if (!this.records.has(id)) return undefined;
    return this.snapshot(id);
  }

  /**
   * Read and, if terminal, freeze wait status and mark collected. Does not
   * snapshot an empty report so late interrupt salvage can still attach.
   * Collect unpins.
   */
  take(id: string): FleetRecord | undefined {
    const overlay = this.records.get(id);
    if (overlay === undefined) return undefined;
    const snap = this.snapshot(id);
    if (!isLiveWaitStatus(snap.status) && overlay.collected !== true) {
      overlay.frozenStatus = snap.status;
      overlay.collected = true;
      if (overlay.pinHeld === true) {
        overlay.pinHeld = false;
        this.sessions?.unpin(id);
      }
    }
    return this.snapshot(id);
  }

  private rememberLiveWaitStatuses(): void {
    for (const [id, overlay] of this.records) {
      const wait = this.sessionWaitStatus(id);
      if (wait === undefined) continue;
      // Do not overwrite lastWait with the session's pending_init/running
      // projection while the overlay is still admission-queued.
      if (overlay.forceQueued === true && isLiveWaitStatus(wait)) continue;
      overlay.lastWaitStatus = wait;
    }
  }

  private waitStatusFromEvicted(id: string): WaitJSONStatus | undefined {
    return waitStatusFromVerbLifecycle(this.sessions.evictedLifecycle(id));
  }

  private sessionWaitStatus(id: string): WaitJSONStatus | undefined {
    const session = this.sessions?.get(id);
    if (session === undefined) return undefined;
    return projectWaitStatus(session.lifecycle, this.sessions?.isRunInFlight(id) === true);
  }

  private projectedStatus(id: string, overlay: FleetOverlay): WaitJSONStatus {
    if (overlay.frozenStatus !== undefined) return overlay.frozenStatus;
    if (this.sessions.hasPendingAsk(id)) return "awaiting_director";
    const live = this.sessionWaitStatus(id);
    if (live !== undefined && !isLiveWaitStatus(live)) {
      overlay.lastWaitStatus = live;
      return live;
    }
    if (overlay.forceQueued === true) return "queued";
    if (overlay.forceInterrupted === true) return "interrupted";
    if (live !== undefined) {
      overlay.lastWaitStatus = live;
      return live;
    }
    const last = overlay.lastWaitStatus;
    if (last !== undefined && !isLiveWaitStatus(last)) return last;
    const evicted = this.waitStatusFromEvicted(id);
    if (evicted !== undefined && !isLiveWaitStatus(evicted)) return evicted;
    return "interrupted";
  }

  snapshot(id: string): FleetRecord {
    const overlay = this.records.get(id);
    if (overlay === undefined) {
      return { status: "running" };
    }
    const session = this.sessions.get(id);
    if (
      session === undefined &&
      overlay.tombstoned !== true &&
      overlay.frozenStatus === undefined
    ) {
      overlay.tombstoned = true;
      overlay.hint = RECOVERY_HINT;
      overlay.frozenStatus = this.projectedStatus(id, overlay);
      if (overlay.pinHeld === true) {
        overlay.pinHeld = false;
        this.sessions.unpin(id);
      }
    }
    const status = this.projectedStatus(id, overlay);
    const sessionWait = this.sessionWaitStatus(id);
    const payload =
      overlay.tombstoned !== true && session !== undefined && sessionWait === status
        ? session
        : undefined;
    const ask = status === "awaiting_director" ? this.sessions.peekAsk(id) : undefined;
    return {
      status,
      ...(overlay.collected === true ? { collected: true } : {}),
      ...(overlay.tombstoned === true ? { tombstoned: true } : {}),
      ...(overlay.hint !== undefined ? { hint: overlay.hint } : {}),
      ...(payload?.report !== undefined ? { report: payload.report } : {}),
      ...(payload?.error !== undefined && status === "failed" ? { error: payload.error } : {}),
      ...(overlay.providerFailure === true ? { providerFailure: true } : {}),
      ...(ask !== undefined ? { question: ask.question, questionId: ask.questionId } : {}),
      ...(status === "awaiting_director" && session !== undefined
        ? { description: session.description }
        : {}),
    };
  }

  private isPayload(id: string, overlay: FleetOverlay): boolean {
    if (overlay.tombstoned === true || overlay.collected === true) return false;
    if (overlay.pinHeld !== true) return false;
    return !isLiveWaitStatus(this.projectedStatus(id, overlay));
  }

  /**
   * Compacts the oldest never-collected pin to a tombstone once more than
   * `MAX_FLEET_RECORDS` terminal payloads are held.
   */
  private enforceCap(): void {
    const payloads: string[] = [];
    for (const [id, overlay] of this.records) {
      if (this.isPayload(id, overlay)) payloads.push(id);
    }
    while (payloads.length > MAX_FLEET_RECORDS) {
      const victimId = payloads.shift();
      if (victimId === undefined) break;
      const victim = this.records.get(victimId);
      if (victim === undefined) break;
      victim.frozenStatus = this.projectedStatus(victimId, victim);
      victim.tombstoned = true;
      victim.hint = RECOVERY_HINT;
      if (victim.pinHeld === true) {
        victim.pinHeld = false;
        this.sessions?.unpin(victimId);
      }
    }
  }
}

// One overlay per orchestrator install (shared by its spawn_agent and
// wait_agents tool instances), not a module singleton — created in
// createSpawnAgentTool and threaded to createWaitAgentsTool by the caller.
export type FleetMailboxHandle = FleetMailbox;
export function createFleetMailbox(sessions: SubAgentSessionStore): FleetMailboxHandle {
  return new FleetMailbox(sessions);
}

const SpawnAgentArgs = type({
  description: "string",
  prompt: "string",
  "context?": "string",
  "agent?": "string",
  "goals?": "string[]",
  "intent?": "'explore' | 'implement' | 'review' | 'plan' | 'general'",
  "success_criteria?": "string[]",
  "do_not?": "string[]",
  "report_focus?": "string",
});

export const spawnAgentToolDefinition: ToolDefinition = {
  name: SPAWN_AGENT_TOOL_NAME,
  description:
    "Start a worker agent and return IMMEDIATELY with its agent_id — this never blocks on the worker's completion. Pass agent= a director/profile id returned by search_agents, or intent= (one of explore|implement|review|plan|general). The child starts blank. success_criteria is required for implement/review (and their default directors). Fire several spawn_agent calls in one turn to start workers in parallel, then use wait_agents to collect them. Excess fan-out is queued rather than refused.",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "A short label for the worker job." },
      prompt: { type: "string", description: "The actionable goal for the worker." },
      context: { type: "string", description: "Optional durable background." },
      goals: {
        type: "array",
        items: { type: "string" },
        description: "Optional ordered checklist seeds for the worker's own manage_tasks list.",
      },
      intent: {
        type: "string",
        enum: ["explore", "implement", "review", "plan", "general"],
        description: "Optional spawn intent; selects a closed director when agent= is omitted.",
      },
      success_criteria: {
        type: "array",
        items: { type: "string" },
        description:
          "Concrete done checks. Required for implement/review (and their default directors); recommended otherwise. Empty or whitespace-only arrays fail closed when required.",
      },
      do_not: {
        type: "array",
        items: { type: "string" },
        description: "Optional explicit out-of-scope actions.",
      },
      report_focus: { type: "string", description: "Optional hint for what Findings must cover." },
      agent: {
        type: "string",
        description: "Optional director id (e.g. from search_agents). Alternative to intent=.",
      },
    },
    required: ["description", "prompt"],
  },
};

const WaitAgentsArgs = type({
  "targets?": "string[]",
  "timeout_ms?": "number",
  "mode?": "'any' | 'all'",
});

export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const MAX_WAIT_TIMEOUT_MS = 300_000;

export const waitAgentsToolDefinition: ToolDefinition = {
  name: "wait_agents",
  description:
    `Block until the given agents reach a terminal state (done, failed, or interrupted), or a worker asks its director (awaiting_director), or timeout_ms elapses. ` +
    `Default mode is "any" (return when the first target finishes or asks). Pass mode="all" to wait until every target is ` +
    `terminal — except a pending ask_director unblocks immediately regardless of mode so the director can send_input. ` +
    `Omit targets to wait on this caller's own uncollected fleet — the workers this spawn_agent/` +
    `wait_agents pair started — never every running session in the shared store. Default timeout ${DEFAULT_WAIT_TIMEOUT_MS}ms, ` +
    `clamped to a ${MAX_WAIT_TIMEOUT_MS}ms max. A timeout or parent-turn abort is NOT an error and never touches ` +
    `the workers — they keep running and remain waitable. Live wait status includes "queued" (waiting for a burst ` +
    `slot), "running", and "awaiting_director". interrupt_agent and close_agent unblock this wait immediately with ` +
    `status "interrupted". awaiting_director is not terminal: re-wait while still pending re-delivers the same question. ` +
    `Answer with send_input (soft). Do not call this in a tight zero-progress loop: a timeout means the targets are still ` +
    `queued, running, or awaiting a director answer, not "try again right away" — do other work, reply to the operator, or change the brief. Calling again with the ` +
    `same targets is a real timed wait, not a spin, but wastes turns if nothing has changed.`,
  inputSchema: {
    type: "object",
    properties: {
      targets: {
        type: "array",
        items: { type: "string" },
        description:
          "agent_id values to wait on. Omit to wait on this caller's uncollected spawned agents only.",
      },
      timeout_ms: {
        type: "number",
        description: `Max time to block, in ms. Default ${DEFAULT_WAIT_TIMEOUT_MS}, clamped to ${MAX_WAIT_TIMEOUT_MS}.`,
      },
      mode: {
        type: "string",
        enum: ["any", "all"],
        description:
          '"any" (default) returns when the first target is terminal or awaiting_director. "all" waits until every target is terminal, but a pending ask still unblocks immediately.',
      },
    },
  },
};

export type AgentFleetDeps = SubAgentSandboxDeps & {
  cwd: string;
  getWorkdirBase: () => string;
  provider: SubAgentProvider | (() => SubAgentProvider);
  run: (params: RunSubAgentParams) => Promise<RunSubAgentResult>;
  sessions: SubAgentSessionStore;
  fleetRecords: FleetMailboxHandle;
  /**
   * Session id of the caller that is mounting this spawn_agent. Nested
   * orchestrators pass their own worker id so close_agent can walk the tree.
   * Omit on the primary session — its children are top-level.
   */
  parentSessionId?: string;
  /** When set, only these director ids may be spawned. */
  spawnAllowlist?: readonly string[];
  /** When false, maySpawn directors cannot remount fleet verbs. Defaults true. */
  allowOrchestrator?: boolean;
  /** Isolate each spawn in a git worktree branched from dispatcher HEAD. */
  useWorktree?: boolean;
  /** Optional wall-clock budget (ms) forwarded to runSubAgent. */
  deadlineMs?: number;
  /** When false, tear the worker down on completion. Default true. */
  persist?: boolean;
  settings?: Settings | (() => Settings | undefined);
  catalog?: readonly ProviderCatalogEntry[] | (() => readonly ProviderCatalogEntry[]);
  profiles?: AgentProfile[] | (() => AgentProfile[]);
  onEvent?: (event: ReactorEmittedEvent) => void;
  onProgress?: (info: { description: string; toolName: string }) => void;
  telemetry?: Telemetry;
  /** Tests inject a private queue. Production omits and uses the process singleton. */
  admission?: AdmissionQueue;
};

function resolveDep<T>(value: T | (() => T)): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

function fleetResult(callId: string, content: string): ToolResult {
  const isError = content.startsWith("Error:");
  return { callId, content, ...(isError ? { isError: true } : {}) };
}

/** Resolve agent=/intent= to a closed director. */
export function resolveDirectorDispatch(
  agentId: string | undefined,
  intent: TaskIntent | undefined,
):
  | {
      ok: true;
      directorId: string;
      systemPromptRole: string;
      capabilities: ReturnType<typeof packageToCapabilities>;
      roleDefault: ReturnType<typeof defaultEffortForDirector>;
      pkg: DirectorPackage;
    }
  | { ok: false; error: string } {
  if (agentId !== undefined && agentId.length > 0) {
    if (!isDirectorId(agentId)) {
      return {
        ok: false,
        error: `Error: unknown director "${agentId}". spawn_agent only supports closed director ids (call search_agents to discover them) or intent=.`,
      };
    }
    const resolved = resolveDirector({ agentId });
    if (!resolved.ok) return { ok: false, error: `Error: ${resolved.error} ${resolved.hint}` };
    const pkg = resolved.package;
    return {
      ok: true,
      directorId: pkg.id,
      systemPromptRole: formatDirectorSystemPrompt(pkg),
      capabilities: packageToCapabilities(pkg),
      roleDefault: defaultEffortForDirector(pkg),
      pkg,
    };
  }
  if (intent !== undefined) {
    const resolved = resolveDirector({ intent });
    if (!resolved.ok) return { ok: false, error: `Error: ${resolved.error} ${resolved.hint}` };
    const pkg = resolved.package;
    return {
      ok: true,
      directorId: pkg.id,
      systemPromptRole: formatDirectorSystemPrompt(pkg),
      capabilities: packageToCapabilities(pkg),
      roleDefault: defaultEffortForDirector(pkg),
      pkg,
    };
  }
  return {
    ok: false,
    error:
      "Error: No director selected. Pass spawn_agent(agent=…) for a named director, or spawn_agent(intent=implement|explore|plan|review).",
  };
}

interface ResolvedAgentDispatch {
  directorId: string;
  agentLabel: string;
  systemPromptRole?: string;
  capabilities?: CapabilityFilter;
  roleDefault?: ReturnType<typeof defaultEffortForDirector>;
  pkg?: DirectorPackage;
  orchestrator: boolean;
  orchestratorTier?: DirectorPackage["tier"];
  nestedSpawnAllowlist?: readonly string[];
  effortPin?: ReasoningEffort;
}

function resolveAgentDispatch(input: {
  agentId: string | undefined;
  intent: TaskIntent | undefined;
  profiles: AgentProfile[] | undefined;
  allowOrchestrator: boolean;
  settings: Settings | undefined;
  applyResolvedProvider: (
    resolved: { provider: string; model: string; reasoningEffort?: ReasoningEffort },
    label: string,
  ) => string | null;
}): ResolvedAgentDispatch | { error: string } {
  const { agentId, intent, profiles, allowOrchestrator, settings, applyResolvedProvider } = input;
  if (agentId !== undefined && agentId.length > 0) {
    if (isDirectorId(agentId)) {
      const resolved = resolveDirector({ agentId });
      if (!resolved.ok) return { error: `Error: ${resolved.error} ${resolved.hint}` };
      const pkg = resolved.package;
      const profile = profiles?.find((p) => p.id === agentId);
      let effortPin: ReasoningEffort | undefined;
      if (profile?.inference !== undefined && settings !== undefined) {
        const outcome = resolveInferenceWithPolicy(profile.inference, settings);
        if (outcome.kind === "unavailable") {
          return {
            error: `Error: agent "${agentId}" unavailable: ${outcome.reason}. Set agentModelFallback: "active" (or change the spec mode to "prefer") to fall back to the active session.`,
          };
        }
        if (outcome.kind === "resolved") {
          const err = applyResolvedProvider(outcome.value, `agent "${agentId}"`);
          if (err !== null) return { error: err };
          effortPin = outcome.value.reasoningEffort;
        }
      }
      const capabilities = packageToCapabilities(pkg);
      const orchestrator = pkg.spawn.maySpawn === true && allowOrchestrator;
      return {
        directorId: pkg.id,
        agentLabel: pkg.id,
        systemPromptRole: formatDirectorSystemPrompt(pkg),
        ...(capabilities !== undefined ? { capabilities } : {}),
        roleDefault: defaultEffortForDirector(pkg),
        pkg,
        orchestrator,
        ...(orchestrator ? { orchestratorTier: pkg.tier } : {}),
        ...(orchestrator && pkg.spawn.allowlist !== undefined && pkg.spawn.allowlist.length > 0
          ? { nestedSpawnAllowlist: pkg.spawn.allowlist }
          : {}),
        ...(effortPin !== undefined ? { effortPin } : {}),
      };
    }

    if (profiles === undefined) {
      return {
        error: `Error: agent "${agentId}" requested but no agent profiles are loaded. Omit agent to use intent=, or ensure profiles are available.`,
      };
    }
    const profile = profiles.find((p) => p.id === agentId);
    if (profile === undefined) {
      const known = profiles.map((p) => p.id).sort();
      const hint =
        known.length > 0
          ? ` Known profiles: ${known.join(", ")}. Call search_agents to discover more (results include full system prompt / body; do not read_file plugin paths outside the workspace).`
          : " No profiles are currently loaded. Call search_agents to discover available agents (results include full system prompt / body).";
      return { error: `Error: unknown agent profile "${agentId}".${hint}` };
    }
    let effortPin: ReasoningEffort | undefined;
    if (profile.inference !== undefined && settings !== undefined) {
      const outcome = resolveInferenceWithPolicy(profile.inference, settings);
      if (outcome.kind === "unavailable") {
        return {
          error: `Error: agent "${agentId}" unavailable: ${outcome.reason}. Set agentModelFallback: "active" (or change the spec mode to "prefer") to fall back to the active session.`,
        };
      }
      if (outcome.kind === "resolved") {
        const err = applyResolvedProvider(outcome.value, `agent "${agentId}"`);
        if (err !== null) return { error: err };
        effortPin = outcome.value.reasoningEffort;
      }
    }
    if (profile.orchestrator === true) {
      return {
        error:
          `Error: agent profile "${agentId}" requests orchestrator=true, but profile ` +
          "orchestrators are not supported for spawn_agent. Use a built-in orchestrator " +
          "director or remove orchestrator from the profile.",
      };
    }
    return {
      directorId: agentId,
      agentLabel: agentId,
      ...(profile.systemPromptRole !== undefined
        ? { systemPromptRole: profile.systemPromptRole }
        : {}),
      ...(profile.capabilities !== undefined ? { capabilities: profile.capabilities } : {}),
      orchestrator: false,
      ...(effortPin !== undefined ? { effortPin } : {}),
    };
  }

  if (intent !== undefined) {
    const resolved = resolveDirector({ intent });
    if (!resolved.ok) return { error: `Error: ${resolved.error} ${resolved.hint}` };
    const pkg = resolved.package;
    const capabilities = packageToCapabilities(pkg);
    const orchestrator = pkg.spawn.maySpawn === true && allowOrchestrator;
    return {
      directorId: pkg.id,
      agentLabel: pkg.id,
      systemPromptRole: formatDirectorSystemPrompt(pkg),
      ...(capabilities !== undefined ? { capabilities } : {}),
      roleDefault: defaultEffortForDirector(pkg),
      pkg,
      orchestrator,
      ...(orchestrator ? { orchestratorTier: pkg.tier } : {}),
      ...(orchestrator && pkg.spawn.allowlist !== undefined && pkg.spawn.allowlist.length > 0
        ? { nestedSpawnAllowlist: pkg.spawn.allowlist }
        : {}),
    };
  }

  return {
    error:
      "Error: No director selected. Pass spawn_agent(agent=...) for a named director/profile, or spawn_agent(intent=implement|explore|plan|review).",
  };
}

// Dual predicate: intent catches plugin profiles; directorId catches omitted-intent defaults.
function handoffRequiresSuccessCriteria(
  intent: TaskIntent | undefined,
  directorId: string,
): boolean {
  if (intent === "implement" || intent === "review") return true;
  return (
    directorId === INTENT_DEFAULT_DIRECTOR.implement ||
    directorId === INTENT_DEFAULT_DIRECTOR.review
  );
}

export function createSpawnAgentTool(deps: AgentFleetDeps): AgentTool {
  const telemetry = deps.telemetry ?? NOOP_TELEMETRY;
  // Concurrent-lane overlap detection, replacing the static per-package
  // writePaths lock. There is no field in the spawn_agent contract a caller
  // uses to declare which files a dispatch will touch, so the only honestly
  // knowable "intended scope" at spawn is the working directory the dispatch
  // will run in — worktree-isolated lanes always get a fresh, disjoint path
  // here, so this can only ever fire in the shared-cwd fallback, which is
  // exactly where two lanes really can stomp each other's writes.
  // Keyed by call.id so a completed lane (removed when the worker settles)
  // is never mistaken for one still running: sequential dispatches to the
  // same cwd are always clean. Tracking lasts the worker lifetime, not the
  // immediate spawn_agent return.
  const activeLanes = new Map<string, { description: string; cwd: string }>();
  let conflictLog: InterventionSink | null = null;
  const recordConflict = (event: Parameters<InterventionSink>[0]): void => {
    conflictLog ??= createInterventionLog(deps.getWorkdirBase(), { role: "parent" });
    conflictLog(event);
  };
  return tool({
    definition: spawnAgentToolDefinition,
    handler: async (call, _signal): Promise<ToolResult> => {
      const args = call.arguments;
      const parsed = SpawnAgentArgs(args);
      if (parsed instanceof type.errors) {
        return fleetResult(call.id, `Error: spawn_agent arguments invalid: ${parsed.summary}`);
      }
      const {
        description: rawDesc,
        context: rawCtx,
        prompt: rawPrompt,
        agent: agentId,
        goals: rawGoals,
        intent: rawIntent,
        success_criteria: rawSuccessCriteria,
        do_not: rawDoNot,
        report_focus: rawReportFocus,
      } = parsed;
      const description = rawDesc.trim();
      const prompt = rawPrompt.trim();
      if (description.length === 0 || prompt.length === 0) {
        return fleetResult(
          call.id,
          "Error: spawn_agent requires a non-empty description and prompt.",
        );
      }
      const context = rawCtx?.trim();
      const goals = rawGoals?.map((g) => g.trim()).filter((g) => g.length > 0) ?? [];
      const intent = rawIntent as TaskIntent | undefined;
      const successCriteria =
        rawSuccessCriteria?.map((c) => c.trim()).filter((c) => c.length > 0) ?? [];
      const doNot = rawDoNot?.map((d) => d.trim()).filter((d) => d.length > 0) ?? [];
      const reportFocus = rawReportFocus?.trim();

      let provider: SubAgentProvider = resolveDep(deps.provider);
      const parentEffort = provider.reasoningEffort;
      const diskSettings = deps.settings !== undefined ? resolveDep(deps.settings) : undefined;
      const catalog = deps.catalog !== undefined ? resolveDep(deps.catalog) : undefined;
      const settings =
        catalog !== undefined ? runtimeSettingsWithCatalog(diskSettings, catalog) : diskSettings;
      const profiles = deps.profiles !== undefined ? resolveDep(deps.profiles) : undefined;
      const applyResolvedProvider = (
        resolved: { provider: string; model: string; reasoningEffort?: ReasoningEffort },
        label: string,
      ): string | null => {
        if (settings === undefined) {
          return `Error: ${label} requires settings with configured providers.`;
        }
        if (resolved.reasoningEffort !== undefined) {
          const verdict = validateEffort(
            resolved.model,
            resolved.reasoningEffort,
            isCodexProviderName(resolved.provider),
          );
          if (!verdict.ok) {
            return `Error: ${label} has incompatible inference: ${verdict.error}`;
          }
        }
        const providerSettings = settings.providers[resolved.provider];
        if (providerSettings === undefined) {
          return `Error: ${label} resolved to provider "${resolved.provider}" which is not configured.`;
        }
        provider = {
          providerName: resolved.provider,
          baseURL: providerSettings.baseURL,
          ...(providerSettings.keyless === true ? { keyless: true } : {}),
          ...(providerSettings.bifrostVirtualKey === true ? { bifrostVirtualKey: true } : {}),
          ...(providerSettings.apiKey !== undefined ? { apiKey: providerSettings.apiKey } : {}),
          model: resolved.model,
        };
        return null;
      };

      const resolved = resolveAgentDispatch({
        agentId,
        intent,
        profiles,
        allowOrchestrator: deps.allowOrchestrator !== false,
        settings,
        applyResolvedProvider,
      });
      if ("error" in resolved) return fleetResult(call.id, resolved.error);
      if (agentId === "skywalker" || resolved.directorId === "skywalker") {
        return fleetResult(
          call.id,
          "Error: skywalker is the primary session identity, not a spawned worker. Pass spawn_agent(agent=...) for a specialist (builder, explorer, counsel, critic, ...).",
        );
      }
      if (deps.spawnAllowlist !== undefined && deps.spawnAllowlist.length > 0) {
        if (!deps.spawnAllowlist.includes(resolved.agentLabel)) {
          return fleetResult(
            call.id,
            `Error: spawn of "${resolved.agentLabel}" is outside this director's allowlist. Allowed: ${deps.spawnAllowlist.join(", ")}.`,
          );
        }
      }
      if (
        handoffRequiresSuccessCriteria(intent, resolved.directorId) &&
        successCriteria.length === 0
      ) {
        return fleetResult(
          call.id,
          "Error: spawn_agent requires non-empty success_criteria for implement/review dispatches (and their default directors).",
        );
      }

      const orchestrator = resolved.orchestrator;
      const nestedSpawnAllowlist = resolved.nestedSpawnAllowlist;
      const effort = resolveEffortForRole({
        orchestrator,
        ...(resolved.effortPin !== undefined ? { pin: resolved.effortPin } : {}),
        ...(resolved.roleDefault !== undefined ? { roleDefault: resolved.roleDefault } : {}),
        ...(parentEffort !== undefined ? { parentEffort } : {}),
        model: provider.model,
        isCodex: isCodexProviderName(provider.providerName),
      });
      if (effort !== undefined) {
        provider = { ...provider, reasoningEffort: effort };
      } else {
        const { reasoningEffort: _drop, ...rest } = provider;
        provider = rest;
      }

      const brief = buildDispatchBrief({
        description,
        prompt,
        ...(context !== undefined && context.length > 0 ? { context } : {}),
        ...(goals.length > 0 ? { goals } : {}),
        ...(intent !== undefined ? { intent } : {}),
        ...(successCriteria.length > 0 ? { successCriteria } : {}),
        ...(doNot.length > 0 ? { doNot } : {}),
        ...(reportFocus !== undefined && reportFocus.length > 0 ? { reportFocus } : {}),
      });

      const session = deps.sessions.start({
        id: call.id,
        description,
        agentId: resolved.directorId,
        brief,
        // A spawn_agent worker's session survives a clean completion instead
        // of being torn down — close_agent (or resume_agent, transitively)
        // governs it from here on.
        retained: true,
        provider: provider.providerName,
        ...(deps.parentSessionId !== undefined ? { parentSessionId: deps.parentSessionId } : {}),
      });
      deps.fleetRecords.register(session.id);
      const agentName = classifyAgentName(resolved.directorId);
      const parentTraceId = getCurrentTurnTraceId();
      telemetry.capture("subagent_start", { agent_name: agentName });
      const startedAt = Date.now();
      let settlement: Readonly<SubAgentRunSettlement> | undefined;
      let endFinalized = false;
      let runInterrupted = false;
      const finalizeEnd = (setupFailed = false): void => {
        if (endFinalized) return;
        endFinalized = true;
        const terminalSession = deps.sessions.get(session.id);
        const status =
          terminalSession?.status === "cancelled"
            ? "cancelled"
            : runInterrupted || terminalSession?.lifecycleStatus === "interrupted"
              ? "interrupted"
              : (terminalSession?.status ?? "completed");
        captureSubagentEnd(telemetry, {
          agentName,
          status: setupFailed ? "failed" : status,
          durationMs: Date.now() - startedAt,
          model: settlement?.model ?? provider.model,
          stopReason: setupFailed ? "setup_error" : (settlement?.terminal_reason ?? "error"),
          rollup: settlement ?? {
            turn_count: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
            tool_call_count: 0,
            tool_error_count: 0,
          },
          ...(parentTraceId !== undefined ? { parentTraceId } : {}),
        });
      };

      const admission = deps.admission ?? getProcessAdmissionQueue();
      const childCtl = new AbortController();
      deps.sessions.registerCancel(session.id, () => {
        admission.cancel(session.id);
        if (!childCtl.signal.aborted) childCtl.abort();
      });

      let providerFailureObserved = false;
      const onEvent = (event: ReactorEmittedEvent): void => {
        if (event.type === "inference.start" || event.type === "inference.done") {
          providerFailureObserved = false;
        } else if (event.type === "inference.error") {
          providerFailureObserved = true;
        }
        deps.sessions.appendEvent(session.id, event);
        deps.onEvent?.(event);
      };

      const nestedDispatch: NestedDispatchDeps | undefined = orchestrator
        ? {
            permissionGate: deps.permissionGate,
            ...(deps.inheritMcpTools !== undefined
              ? { inheritMcpTools: deps.inheritMcpTools }
              : {}),
            ...(deps.shellTimeout !== undefined ? { shellTimeout: deps.shellTimeout } : {}),
            ...(deps.shellEnv !== undefined ? { shellEnv: deps.shellEnv } : {}),
            ...(deps.extraToolPlugins !== undefined
              ? { extraToolPlugins: deps.extraToolPlugins }
              : {}),
            ...(deps.getBlobReader !== undefined ? { getBlobReader: deps.getBlobReader } : {}),
            getWorkdirBase: deps.getWorkdirBase,
            provider: deps.provider,
            ...(deps.onEvent !== undefined ? { onEvent: deps.onEvent } : {}),
            ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {}),
            sessions: deps.sessions,
            ...(settings !== undefined ? { settings } : {}),
            ...(catalog !== undefined ? { catalog } : {}),
            ...(deps.profiles !== undefined ? { profiles: deps.profiles } : {}),
            parentSessionId: session.id,
            ...(deps.useWorktree !== undefined ? { useWorktree: deps.useWorktree } : {}),
            ...(nestedSpawnAllowlist !== undefined ? { spawnAllowlist: nestedSpawnAllowlist } : {}),
            admission,
          }
        : undefined;

      // Aligns with run.ts: (persist && turnSucceeded) || interruptedKeepAlive.
      // When true, the worktree stays until close_agent / eviction calls the
      // wrapped close below; otherwise the run's finally reclaims it immediately.
      let keepWorktreeAlive = false;
      let worktreeCwd: string | undefined;
      let worktreeStashBaseline: readonly string[] | null = [];
      let worktreeHeadAtCreate: string | undefined;
      const reclaimWorktree = async (): Promise<void> => {
        if (worktreeCwd === undefined) return;
        const path = worktreeCwd;
        worktreeCwd = undefined;
        try {
          await cleanupSubAgentWorktree(deps.cwd, path, {
            stashBaseline: worktreeStashBaseline,
            ...(worktreeHeadAtCreate !== undefined ? { headAtCreate: worktreeHeadAtCreate } : {}),
          });
        } catch (err: unknown) {
          log.error("spawn_agent worktree cleanup failed: {error}", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };

      const stillAdmissible = (): boolean => {
        const live = deps.sessions.get(session.id);
        if (live === undefined) return false;
        const state = live.lifecycle.state;
        // Interrupted lingers on the strip (isLiveStrip) but must not start run().
        return state === "pending_init" || state === "running";
      };

      const start = (): void => {
        if (!stillAdmissible()) {
          admission.release(session.id);
          return;
        }
        deps.fleetRecords.clearQueued(session.id);
        deps.sessions.markRunInFlight(session.id);
        void (async () => {
          if (!stillAdmissible()) {
            admission.release(session.id);
            return;
          }

          if (deps.useWorktree === true) {
            const worktreePath = join(deps.getWorkdirBase(), "worktrees", generateSessionId());
            try {
              const worktree = await createSubAgentWorktree(deps.cwd, worktreePath);
              worktreeCwd = worktree.path;
              worktreeStashBaseline = worktree.stashBaseline;
              worktreeHeadAtCreate = worktree.headAtCreate;
            } catch (err) {
              const message =
                err instanceof WorktreeError
                  ? err.message
                  : `sub-agent worktree setup failed: ${err instanceof Error ? err.message : String(err)}`;
              log.error("spawn_agent worktree setup failed: {error}", { error: message });
              deps.sessions.fail(session.id, message);
              finalizeEnd(true);
              admission.release(session.id);
              return;
            }
          }

          if (!stillAdmissible()) {
            await reclaimWorktree();
            admission.release(session.id);
            return;
          }

          // Detect, don't lock: warn when another lane still running right now
          // is already working in this same cwd. Worktree-isolated lanes never
          // collide here (each gets its own directory); this only fires in the
          // shared-cwd fallback, where two lanes genuinely can overwrite each
          // other's writes. Never blocks the spawn — the least destructive
          // response that still tells the operator something true, since a
          // shared cwd does not by itself prove the two lanes touch the same
          // files, only that they could.
          const laneCwd = worktreeCwd ?? deps.cwd;
          for (const [otherId, other] of activeLanes) {
            if (other.cwd !== laneCwd) continue;
            recordConflict({
              id: "concurrent-lane-overlap",
              class: "conflict",
              detail:
                `"${description}" (${call.id}) and "${other.description}" (${otherId}) ` +
                `are both running against ${laneCwd} at once`,
            });
          }
          activeLanes.set(call.id, { description, cwd: laneCwd });

          const params: RunSubAgentParams = {
            // Name the trace directory after the session-store id so the
            // descendant-scoping check behind read_agent_trace can resolve this
            // worker's parent chain.
            id: session.id,
            permissionGate: deps.permissionGate,
            ...(deps.inheritMcpTools !== undefined
              ? { inheritMcpTools: deps.inheritMcpTools }
              : {}),
            ...(deps.shellTimeout !== undefined ? { shellTimeout: deps.shellTimeout } : {}),
            ...(deps.shellEnv !== undefined ? { shellEnv: deps.shellEnv } : {}),
            ...(deps.extraToolPlugins !== undefined
              ? { extraToolPlugins: deps.extraToolPlugins }
              : {}),
            ...(deps.getBlobReader !== undefined ? { getBlobReader: deps.getBlobReader } : {}),
            cwd: worktreeCwd ?? deps.cwd,
            workdirBase: deps.getWorkdirBase(),
            provider,
            ...(settings !== undefined ? { settings } : {}),
            ...(catalog !== undefined ? { catalog } : {}),
            description,
            ...(context !== undefined && context.length > 0 ? { context } : {}),
            prompt,
            ...(goals.length > 0 ? { goals } : {}),
            ...(intent !== undefined ? { intent } : {}),
            ...(successCriteria.length > 0 ? { successCriteria } : {}),
            ...(doNot.length > 0 ? { doNot } : {}),
            ...(reportFocus !== undefined && reportFocus.length > 0 ? { reportFocus } : {}),
            signal: childCtl.signal,
            admission,
            onEvent,
            onRunSettled: (summary) => {
              settlement = summary;
            },
            ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {}),
            ...(resolved.capabilities !== undefined ? { capabilities: resolved.capabilities } : {}),
            ...(resolved.systemPromptRole !== undefined
              ? { systemPromptRole: resolved.systemPromptRole }
              : {}),
            directorId: resolved.directorId,
            ...(orchestrator
              ? {
                  orchestrator: true,
                  ...(resolved.orchestratorTier !== undefined
                    ? { orchestratorTier: resolved.orchestratorTier }
                    : {}),
                  nestedDispatch: nestedDispatch!,
                }
              : {}),
            ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
            ...(resolved.pkg !== undefined
              ? { tier: resolved.pkg.tier }
              : orchestrator
                ? {}
                : { tier: "leaf" }),
            ...(resolved.pkg?.reportContract?.outputType !== undefined
              ? { reportType: resolved.pkg.reportContract.outputType }
              : {}),
            persist: deps.persist !== false,
            askDirectorPort: {
              register: ({ question, questionId }) => {
                const hold: {
                  resolve?: (answer: string) => void;
                  reject?: (reason: unknown) => void;
                } = {};
                const answer = new Promise<string>((resolve, reject) => {
                  hold.resolve = resolve;
                  hold.reject = reject;
                });
                if (hold.resolve === undefined || hold.reject === undefined) {
                  const err = new Error("ask_director could not register a pending question");
                  hold.reject?.(err);
                  void answer.catch(() => {});
                  throw err;
                }
                const ok = deps.sessions.registerAsk(session.id, {
                  question,
                  questionId,
                  resolve: hold.resolve,
                  reject: hold.reject,
                });
                if (!ok) {
                  const err = new Error("ask_director could not register a pending question");
                  hold.reject(err);
                  void answer.catch(() => {});
                  throw err;
                }
                return answer;
              },
              cancel: (reason) => {
                deps.sessions.cancelAsk(session.id, reason);
              },
            },
            onAgentReady: ({ close, interrupt, followup, deliver }) => {
              deps.sessions.registerClose(session.id, async (deadlineMs) => {
                try {
                  await close(deadlineMs);
                } finally {
                  await reclaimWorktree();
                }
              });
              deps.sessions.registerInterrupt(session.id, interrupt);
              deps.sessions.registerFollowup(session.id, followup);
              deps.sessions.registerDeliver(session.id, deliver);
              deps.sessions.markRunning(session.id);
            },
          };

          // Fire and forget: this handler must return before the worker finishes.
          // Wait JSON projects stored WorkerLifecycle plus the per-install overlay.
          deps
            .run(params)
            .then((result) => {
              if (result.interrupted === true) {
                keepWorktreeAlive = true;
                runInterrupted = true;
                const now = deps.sessions.get(session.id);
                const overlay = deps.fleetRecords.peek(session.id);
                const followupLive =
                  now?.lifecycle.state === "running" && overlay?.status === "interrupted";
                if (!followupLive) {
                  deps.sessions.attachReport(session.id, result.report);
                }
                return;
              }
              const alreadyCancelled = deps.sessions.get(session.id)?.status === "cancelled";
              if (alreadyCancelled) {
                deps.sessions.attachReport(session.id, result.report);
                return;
              }
              const agentRetained = result.agentRetained === true;
              if (agentRetained) keepWorktreeAlive = true;
              deps.sessions.complete(session.id, result.report, {
                agentRetained,
                ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
              });
            })
            .catch((err) => {
              const alreadyCancelled = deps.sessions.get(session.id)?.status === "cancelled";
              if (alreadyCancelled || isSubAgentCancelError(err, childCtl.signal)) {
                if (!alreadyCancelled) {
                  deps.sessions.cancel(session.id, DEFAULT_CANCEL_REASON);
                }
                deps.sessions.settleRun(session.id);
                return;
              }
              const isProviderFailure = isResolvedProviderFailureError(err);
              const diagnosticMessage = err instanceof Error ? err.message : String(err);
              const authMessage = formatSubAgentSpawnAuthFailureMessage(description, err);
              const failReason = authMessage ?? diagnosticMessage;
              if (isProviderFailure || providerFailureObserved) {
                deps.fleetRecords.markProviderFailure(session.id);
              }
              deps.sessions.fail(session.id, failReason);
            })
            .finally(() => {
              activeLanes.delete(call.id);
              finalizeEnd();
              if (!keepWorktreeAlive) void reclaimWorktree();
              admission.release(session.id);
            });
        })();
      };

      const status = admission.enqueue({
        id: session.id,
        provider: provider.providerName,
        bypass: deps.parentSessionId !== undefined,
        start,
      });
      if (status === "queued") deps.fleetRecords.markQueued(session.id);
      return fleetResult(call.id, JSON.stringify({ agent_id: session.id, status }));
    },
  });
}

interface WaitAgentsAuthority {
  actorId: string | undefined;
  tier: SubagentTier;
  getNodes: () => readonly FleetNode[];
}

interface WaitAgentsDeps {
  sessions: SubAgentSessionStore;
  fleetRecords: FleetMailboxHandle;
  authority?: WaitAgentsAuthority;
}

function isWaitTerminal(id: string, fleetRecords: FleetMailboxHandle): boolean {
  const record = fleetRecords.peek(id);
  return record !== undefined && !isLiveWaitStatus(record.status);
}

/**
 * Blocks until `mode` is satisfied for `targets`, or `timeoutMs` / abort
 * elapses. Driven by the session store's mailbox (`subscribe`) raced against
 * a timer and the parent tool signal; never polls. Timeout and abort have no
 * side effects: workers keep running and remain waitable. Overlay writers
 * wake this wait via `sessions.wake()`.
 */
async function waitForTerminal(
  sessions: SubAgentSessionStore,
  fleetRecords: FleetMailboxHandle,
  targets: readonly string[],
  timeoutMs: number,
  mode: "any" | "all",
  signal?: AbortSignal,
): Promise<boolean> {
  const ready = (): boolean => {
    if (targets.some((id) => fleetRecords.peek(id)?.status === "awaiting_director")) return true;
    return mode === "all"
      ? targets.every((id) => isWaitTerminal(id, fleetRecords))
      : targets.some((id) => isWaitTerminal(id, fleetRecords));
  };
  if (signal?.aborted) return true;
  if (ready()) return false;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribeSessions();
      signal?.removeEventListener("abort", onAbort);
      resolve(timedOut);
    };
    const onAbort = (): void => finish(true);
    const onChange = (): void => {
      if (ready()) finish(false);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    const unsubscribeSessions = sessions.subscribe(onChange);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) finish(true);
  });
}

export function createWaitAgentsTool(deps: WaitAgentsDeps): AgentTool {
  return tool({
    definition: waitAgentsToolDefinition,
    handler: async (call, signal): Promise<ToolResult> => {
      const parsed = WaitAgentsArgs(call.arguments);
      if (parsed instanceof type.errors) {
        return fleetResult(call.id, `Error: wait_agents arguments invalid: ${parsed.summary}`);
      }
      const requestedTimeout = parsed.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS;
      const timeoutMs = Math.min(Math.max(requestedTimeout, 0), MAX_WAIT_TIMEOUT_MS);
      const mode = parsed.mode ?? "any";

      const targets =
        parsed.targets !== undefined && parsed.targets.length > 0
          ? parsed.targets
          : deps.fleetRecords.uncollectedIds();

      if (targets.length === 0) {
        return fleetResult(call.id, JSON.stringify({ results: [], timed_out: false }));
      }

      if (deps.authority !== undefined) {
        if (deps.authority.actorId === undefined) {
          return fleetResult(
            call.id,
            "Error: wait_agents is unavailable for this worker (no resolvable session id to scope descendant access).",
          );
        }
        try {
          for (const target of targets) {
            assertCanTargetAgent(
              { id: deps.authority.actorId, tier: deps.authority.tier },
              target,
              deps.authority.getNodes(),
            );
          }
        } catch (cause) {
          if (cause instanceof FleetAuthorityError) {
            return fleetResult(call.id, `Error: ${cause.message}`);
          }
          throw cause;
        }
      }

      const timedOut = await waitForTerminal(
        deps.sessions,
        deps.fleetRecords,
        targets,
        timeoutMs,
        mode,
        signal,
      );

      // Terminal overlay/session projections are marked collected once
      // delivered here; a running record is only peeked, so it stays waitable.
      const results = targets.map((id) => {
        const record = deps.fleetRecords.peek(id);
        if (record === undefined) {
          return { agent_id: id, status: "unknown" as const };
        }
        if (isLiveWaitStatus(record.status)) {
          return { agent_id: id, status: record.status };
        }
        const taken = deps.fleetRecords.take(id) ?? record;
        return {
          agent_id: id,
          status: taken.status,
          ...(taken.question !== undefined ? { question: taken.question } : {}),
          ...(taken.questionId !== undefined ? { question_id: taken.questionId } : {}),
          ...(taken.description !== undefined ? { description: taken.description } : {}),
          ...(taken.status !== "failed" && taken.report !== undefined
            ? { report: taken.report }
            : {}),
          ...(taken.error !== undefined ? { error: taken.error } : {}),
          ...(taken.providerFailure === true ? { provider_failure: true } : {}),
          ...(taken.hint !== undefined ? { hint: taken.hint } : {}),
        };
      });

      return fleetResult(call.id, JSON.stringify({ results, timed_out: timedOut }));
    },
  });
}

export const listAgentsToolDefinition: ToolDefinition = {
  name: "list_agents",
  description:
    "List the workers this session started with spawn_agent — the same fleet wait_agents " +
    "collects. Does not list siblings or another orchestrator's workers. Each entry is id, " +
    "director, description, wait status, lifecycle, and whether wait_agents already collected it. " +
    "When status is awaiting_director, the entry also includes question and question_id.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export function createListAgentsTool(deps: WaitAgentsDeps): AgentTool {
  return tool({
    definition: listAgentsToolDefinition,
    handler: async (call, _signal): Promise<ToolResult> => {
      const agents = deps.fleetRecords.ids().map((id) => {
        const record = deps.fleetRecords.peek(id);
        const session = deps.sessions.get(id);
        return {
          agent_id: id,
          status: record?.status ?? "unknown",
          collected: record?.collected === true,
          ...(session !== undefined
            ? {
                director: session.agentId,
                description: session.description,
                lifecycle: session.lifecycleStatus,
              }
            : {}),
          ...(record?.status === "awaiting_director" && record.question !== undefined
            ? { question: record.question }
            : {}),
          ...(record?.status === "awaiting_director" && record.questionId !== undefined
            ? { question_id: record.questionId }
            : {}),
        };
      });
      return fleetResult(call.id, JSON.stringify({ agents }));
    },
  });
}
