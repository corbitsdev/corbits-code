/**
 * spawn_agent / wait_agents: the non-blocking half of fleet dispatch,
 * split out of `task()`'s fused spawn+wait.
 *
 * `task()` (task-tool.ts) remains the deprecated fused spawn+wait fallback.
 * These two verbs are the supported fleet path: start several workers in one
 * turn (spawn_agent returns immediately) and later block on this caller's
 * own workers (wait_agents), instead of one task() call per worker
 * serializing the wait.
 *
 * Running state and the mailbox (`subscribe`) are the existing
 * SubAgentSessionStore's — wait_agents' blocking is driven by that
 * `subscribe` raced against a timeout timer, never polling. But the store's
 * finished-session retention is a TUI display cap (`maxCompleted`, default
 * 20): `complete()`/`fail()` evict the oldest finished session — report and
 * all — once more than that many have finished. task() never hit this
 * because it awaits its own single result before the tool call returns; here
 * a caller can spawn far more workers than the cap in one turn and only
 * `wait_agents` them later, so an evicted report would otherwise vanish
 * silently. `fleetRecords` below is a small, deliberately-separate map
 * (agent id -> terminal status/report/error), kept alive across the store's
 * own eviction and cleared only when `wait_agents` delivers a result to a
 * caller — it exists precisely because the store's cap cannot be trusted for
 * this use. Its heavy payloads (report/error text) are capped at
 * `MAX_FLEET_RECORDS`: past that, the oldest already-collected entry is
 * compacted to a tombstone (status only, plus a pointer at
 * `read_agent_trace` for the detail), falling back to the oldest
 * uncollected one only once every collected entry is gone — a caller who
 * never called wait_agents still gets a terminal status, never a bare
 * "unknown".
 *
 * Argument shape intentionally mirrors `task()`'s (description/prompt/
 * context/goals/intent/success_criteria/do_not/report_focus) so a
 * caller can swap one for the other. Scope is deliberately narrower than
 * `task()` for this first cut: only closed-director dispatch (`agent=` a
 * director id, or `intent=`) is supported — no custom AgentProfile lookup,
 * no nested orchestration, no re-dispatch ledger. Those remain `task()`-only
 * for now; nothing here stops adding them later.
 *
 */

import { tool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import { type } from "arktype";
import type { ToolDefinition, ToolResult } from "@intx/types/runtime";
import type { ReactorEmittedEvent } from "@intx/inference";

import type { ProviderCatalogEntry } from "../config/index.js";
import {
  isDirectorId,
  packageToCapabilities,
  resolveDirector,
} from "../agent/directors/registry.js";
import {
  defaultEffortForDirector,
  formatDirectorSystemPrompt,
} from "../agent/directors/identity.js";
import type { Settings } from "../config/settings.js";
import { resolveEffortForRole } from "../provider/reasoning-effort.js";
import { isCodexProviderName } from "../config/codex-providers.js";
import { buildDispatchBrief, type TaskIntent } from "./report.js";
import type { SubAgentSessionStore } from "./session-store.js";
import type {
  RunSubAgentParams,
  RunSubAgentResult,
  SubAgentProvider,
  SubAgentSandboxDeps,
} from "./types.js";
import { NOOP_TELEMETRY, type Telemetry } from "../telemetry/index.js";
import { classifyAgentName } from "../telemetry/classify.js";

/** Terminal (or running) record for one spawned agent, keyed by agent id. */
interface FleetRecord {
  status: "running" | "done" | "failed" | "interrupted";
  report?: string;
  error?: string;
  /** Set once a wait_agents caller has been handed this result. */
  collected?: boolean;
  /** Set once the payload has been compacted away to bound memory. */
  tombstoned?: boolean;
  /** Present only on a tombstoned record — how to recover the detail. */
  hint?: string;
}

const RECOVERY_HINT =
  "Report evicted to bound fleet memory; recover full detail via read_agent_trace(agent_id).";

/** Payload cap: terminal records still holding a report/error. */
export const MAX_FLEET_RECORDS = 200;

/**
 * Terminal-result store, cleared once a result is delivered to a
 * wait_agents caller. See the module doc comment for why the session
 * store's own retention cannot be reused here, and for the tombstone
 * eviction policy once more than `MAX_FLEET_RECORDS` payloads are held.
 */
class FleetRecords {
  private readonly records = new Map<string, FleetRecord>();
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  register(id: string): void {
    this.records.set(id, { status: "running" });
  }

  resolve(id: string, report: string): void {
    const existing = this.records.get(id);
    if (existing !== undefined && existing.status !== "running") return;
    this.records.set(id, { status: "done", report });
    this.enforceCap();
    this.notify();
  }

  reject(id: string, error: string): void {
    const existing = this.records.get(id);
    if (existing !== undefined && existing.status !== "running") return;
    this.records.set(id, { status: "failed", error });
    this.enforceCap();
    this.notify();
  }

  /**
   * Marks a still-running record interrupted so wait_agents unblocks.
   * No-op on an already-terminal id that is not interrupted — a late
   * interrupt after complete/fail is meaningless. A late salvage report may
   * still attach to an interrupted record that has none yet (including after
   * an early collect), but never overwrites an existing report.
   */
  interrupt(id: string, report?: string): void {
    const existing = this.records.get(id);
    if (existing === undefined) return;
    if (
      existing.status === "interrupted" &&
      report !== undefined &&
      existing.report === undefined
    ) {
      existing.report = report;
      this.notify();
      return;
    }
    if (existing.status !== "running") return;
    this.records.set(id, {
      status: "interrupted",
      ...(report !== undefined ? { report } : {}),
    });
    this.enforceCap();
    this.notify();
  }

  /**
   * send_input interrupt:true queued a followup that has now finished.
   * Upgrade an uncollected interrupted record to done. No-op if wait_agents
   * already collected the interrupt, so a later reply cannot resurrect it.
   */
  completeAfterInterrupt(id: string, report: string): void {
    const existing = this.records.get(id);
    if (existing === undefined || existing.collected === true) return;
    if (existing.status !== "interrupted") return;
    this.records.set(id, { status: "done", report });
    this.enforceCap();
    this.notify();
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
    return this.records.get(id);
  }

  /**
   * Read and, if terminal, mark collected. The entry is kept (not deleted)
   * so a later query still resolves to a real status instead of "unknown" —
   * it just becomes the preferred eviction target once the payload cap is
   * hit.
   */
  take(id: string): FleetRecord | undefined {
    const record = this.records.get(id);
    if (record !== undefined && record.status !== "running") {
      record.collected = true;
    }
    return record;
  }

  private hasPayload(record: FleetRecord): boolean {
    return record.status !== "running" && !record.tombstoned;
  }

  /**
   * Compacts the oldest already-collected payload to a tombstone first —
   * its caller already has the detail — and only reaches into uncollected
   * payloads once no collected one remains.
   */
  private enforceCap(): void {
    let payloadCount = 0;
    for (const record of this.records.values()) {
      if (this.hasPayload(record)) payloadCount++;
    }
    while (payloadCount > MAX_FLEET_RECORDS) {
      const victim =
        [...this.records.values()].find((r) => this.hasPayload(r) && r.collected === true) ??
        [...this.records.values()].find((r) => this.hasPayload(r));
      if (victim === undefined) break;
      delete victim.report;
      delete victim.error;
      victim.tombstoned = true;
      victim.hint = RECOVERY_HINT;
      payloadCount--;
    }
  }
}

// One registry per orchestrator install (shared by its spawn_agent and
// wait_agents tool instances), not a module singleton — created in
// createSpawnAgentTool and threaded to createWaitAgentsTool by the caller.
export type FleetRecordsHandle = FleetRecords;
export function createFleetRecords(): FleetRecordsHandle {
  return new FleetRecords();
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
  name: "spawn_agent",
  description:
    "Start a worker agent and return IMMEDIATELY with its agent_id — this never blocks on the worker's completion. Same brief fields as task() (description/prompt/context/goals/intent/success_criteria/do_not/report_focus); pass agent= a director id or intent= (one of explore|implement|review|plan|general). Fire several spawn_agent calls in one turn to start workers in parallel, then use wait_agents to collect them. task() is the deprecated fused spawn+wait fallback for a single blocking worker.",
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
        description: "Optional concrete done checks.",
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
    `Block until the given agents reach a terminal state (done, failed, or interrupted), or timeout_ms elapses. ` +
    `Default mode is "any" (return when the first target finishes). Pass mode="all" to wait until every target is ` +
    `terminal. Omit targets to wait on this caller's own uncollected fleet — the workers this spawn_agent/` +
    `wait_agents pair started — never every running session in the shared store. Default timeout ${DEFAULT_WAIT_TIMEOUT_MS}ms, ` +
    `clamped to a ${MAX_WAIT_TIMEOUT_MS}ms max. A timeout or parent-turn abort is NOT an error and never touches ` +
    `the workers — they keep running and remain waitable. interrupt_agent and close_agent unblock this wait immediately with ` +
    `status "interrupted". Do not call this in a tight zero-progress loop: a timeout means "still running", not ` +
    `"try again right away" — do other work, reply to the operator, or change the brief. Calling again with the ` +
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
          '"any" (default) returns when the first target is terminal. "all" waits until every target is terminal.',
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
  fleetRecords: FleetRecordsHandle;
  /**
   * Session id of the caller that is mounting this spawn_agent. Nested
   * orchestrators pass their own worker id so close_agent can walk the tree.
   * Omit on the primary session — its children are top-level.
   */
  parentSessionId?: string;
  settings?: Settings | (() => Settings | undefined);
  catalog?: readonly ProviderCatalogEntry[] | (() => readonly ProviderCatalogEntry[]);
  onEvent?: (event: ReactorEmittedEvent) => void;
  onProgress?: (info: { description: string; toolName: string }) => void;
  telemetry?: Telemetry;
};

function resolveDep<T>(value: T | (() => T)): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

function fleetResult(callId: string, content: string): ToolResult {
  const isError = content.startsWith("Error:");
  return { callId, content, ...(isError ? { isError: true } : {}) };
}

/** Resolve agent=/intent= to a closed director. Mirrors task()'s director-only branch. */
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
    };
  }
  return {
    ok: false,
    error:
      "Error: No director selected. Pass spawn_agent(agent=…) for a named director, or spawn_agent(intent=implement|explore|plan|review).",
  };
}

export function createSpawnAgentTool(deps: AgentFleetDeps): AgentTool {
  const telemetry = deps.telemetry ?? NOOP_TELEMETRY;
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

      const resolved = resolveDirectorDispatch(agentId, intent);
      if (!resolved.ok) return fleetResult(call.id, resolved.error);

      const settings = deps.settings !== undefined ? resolveDep(deps.settings) : undefined;

      let provider: SubAgentProvider = resolveDep(deps.provider);
      const effort = resolveEffortForRole({
        orchestrator: false,
        roleDefault: resolved.roleDefault,
        ...(provider.reasoningEffort !== undefined
          ? { parentEffort: provider.reasoningEffort }
          : {}),
        model: provider.model,
        isCodex: isCodexProviderName(provider.providerName),
      });
      provider = effort !== undefined ? { ...provider, reasoningEffort: effort } : provider;

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
        description,
        agentId: resolved.directorId,
        brief,
        // A spawn_agent worker's session survives a clean completion instead
        // of being torn down — close_agent (or resume_agent, transitively)
        // governs it from here on.
        retained: true,
        ...(deps.parentSessionId !== undefined ? { parentSessionId: deps.parentSessionId } : {}),
      });
      deps.fleetRecords.register(session.id);
      const agentName = classifyAgentName(resolved.directorId);
      telemetry.capture("subagent_start", { agent_name: agentName });
      const startedAt = Date.now();

      const childCtl = new AbortController();
      deps.sessions.registerCancel(session.id, () => {
        if (!childCtl.signal.aborted) childCtl.abort();
      });

      const onEvent = (event: ReactorEmittedEvent): void => {
        deps.sessions.appendEvent(session.id, event);
        deps.onEvent?.(event);
      };

      const catalog = deps.catalog !== undefined ? resolveDep(deps.catalog) : undefined;
      const params: RunSubAgentParams = {
        // Name the trace directory after the session-store id so the
        // descendant-scoping check behind read_agent_trace can resolve this
        // worker's parent chain (matches task-tool.ts).
        id: session.id,
        permissionGate: deps.permissionGate,
        ...(deps.inheritMcpTools !== undefined ? { inheritMcpTools: deps.inheritMcpTools } : {}),
        ...(deps.shellTimeout !== undefined ? { shellTimeout: deps.shellTimeout } : {}),
        ...(deps.shellEnv !== undefined ? { shellEnv: deps.shellEnv } : {}),
        ...(deps.extraToolPlugins !== undefined ? { extraToolPlugins: deps.extraToolPlugins } : {}),
        ...(deps.getBlobReader !== undefined ? { getBlobReader: deps.getBlobReader } : {}),
        cwd: deps.cwd,
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
        onEvent,
        ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {}),
        ...(resolved.capabilities !== undefined ? { capabilities: resolved.capabilities } : {}),
        systemPromptRole: resolved.systemPromptRole,
        directorId: resolved.directorId,
        // Keep the session open after a clean completion, and hand the
        // store a bounded close for close_agent to call later.
        persist: true,
        onAgentReady: ({ close, interrupt, followup, deliver }) => {
          deps.sessions.registerClose(session.id, close);
          deps.sessions.registerInterrupt(session.id, interrupt);
          deps.sessions.registerFollowup(session.id, followup);
          deps.sessions.registerDeliver(session.id, deliver);
          deps.sessions.markRunning(session.id);
        },
      };

      // Fire and forget: this handler must return before the worker finishes.
      // fleetRecords is the durable source of truth wait_agents reads from
      // (see the module doc for its own cap/eviction policy);
      // deps.sessions.complete/fail is still called for the TUI's benefit,
      // but only after fleetRecords already has the result, so the
      // synchronous subscribe notification always sees the up-to-date
      // record.
      deps
        .run(params)
        .then((result) => {
          // interrupt_agent already flipped this session to "interrupted"
          // synchronously (session-store.interruptOne) — do not let the
          // settling promise's normal bookkeeping overwrite that with a
          // "completed" status. Still terminalize fleetRecords so a waiter
          // that never saw interrupt_agent (or raced it) cannot hang.
          if (result.interrupted === true) {
            deps.fleetRecords.interrupt(session.id, result.report);
            return;
          }
          // Operator cancel may race after run resolves (childCtl aborted).
          // Keep strip status cancelled when sessions.cancel already flipped
          // it, but never discard a returned body (including salvage) —
          // wait_agents reads fleetRecords, not the strip.
          deps.fleetRecords.resolve(session.id, result.report);
          // result.agentRetained is only true on run.ts's clean-completion
          // path when persist actually skipped teardown — a deadline/cancel
          // salvage resolves through the same promise but always disposed
          // its agent first, so the store must not treat it as resumable
          // just because retained:true was requested at spawn.
          // complete() no-ops when status is already cancelled.
          deps.sessions.complete(session.id, result.report, {
            agentRetained: result.agentRetained === true,
            ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
          });
        })
        .catch((err) => {
          // Always terminalize fleetRecords — including pre-progress cancel that
          // rethrows with no salvage — so wait_agents does not hang. fail()
          // no-ops when cancel already flipped the strip status.
          const message = err instanceof Error ? err.message : String(err);
          deps.fleetRecords.reject(session.id, message);
          deps.sessions.fail(session.id, message);
        })
        .finally(() => {
          telemetry.capture("subagent_end", {
            agent_name: agentName,
            status: deps.sessions.get(session.id)?.status ?? "completed",
            duration_ms: Date.now() - startedAt,
          });
        });

      return fleetResult(call.id, JSON.stringify({ agent_id: session.id, status: "running" }));
    },
  });
}

interface WaitAgentsDeps {
  sessions: SubAgentSessionStore;
  fleetRecords: FleetRecordsHandle;
}

function isSoftInterrupted(
  session: ReturnType<SubAgentSessionStore["get"]>,
): session is NonNullable<ReturnType<SubAgentSessionStore["get"]>> {
  // interrupt_agent keeps strip status "running" so followup_task can reuse
  // the session. cancel() also sets lifecycleStatus "interrupted" but flips
  // status to "cancelled" — that path still owes wait_agents a salvage
  // report via fleetRecords, so it is not wait-terminal on its own.
  return (
    session !== undefined &&
    session.status === "running" &&
    (session.lifecycleStatus === "interrupted" || session.lifecycleStatus === "shutdown")
  );
}

function isWaitTerminal(
  id: string,
  sessions: SubAgentSessionStore,
  fleetRecords: FleetRecordsHandle,
): boolean {
  const record = fleetRecords.peek(id);
  if (record !== undefined && record.status !== "running") return true;
  return isSoftInterrupted(sessions.get(id));
}

/**
 * Blocks until `mode` is satisfied for `targets`, or `timeoutMs` / abort
 * elapses. Driven by the session store's mailbox (`subscribe`) raced against
 * a timer and the parent tool signal; never polls. Timeout and abort have no
 * side effects: workers keep running and remain waitable.
 */
async function waitForTerminal(
  sessions: SubAgentSessionStore,
  fleetRecords: FleetRecordsHandle,
  targets: readonly string[],
  timeoutMs: number,
  mode: "any" | "all",
  signal?: AbortSignal,
): Promise<boolean> {
  const ready = (): boolean =>
    mode === "all"
      ? targets.every((id) => isWaitTerminal(id, sessions, fleetRecords))
      : targets.some((id) => isWaitTerminal(id, sessions, fleetRecords));
  if (signal?.aborted) return true;
  if (ready()) return false;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribeSessions();
      unsubscribeFleet();
      signal?.removeEventListener("abort", onAbort);
      resolve(timedOut);
    };
    const onAbort = (): void => finish(true);
    const onChange = (): void => {
      if (ready()) finish(false);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    const unsubscribeSessions = sessions.subscribe(onChange);
    const unsubscribeFleet = fleetRecords.subscribe(onChange);
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

      const timedOut = await waitForTerminal(
        deps.sessions,
        deps.fleetRecords,
        targets,
        timeoutMs,
        mode,
        signal,
      );

      // Terminal fleet records are marked collected once delivered here; a
      // running record is only peeked, so it stays waitable. Session
      // lifecycle is a fallback for interrupt/close that raced the record.
      const results = targets.map((id) => {
        const record = deps.fleetRecords.peek(id);
        if (record !== undefined && record.status !== "running") {
          const taken = deps.fleetRecords.take(id) ?? record;
          return {
            agent_id: id,
            status: taken.status,
            ...(taken.report !== undefined ? { report: taken.report } : {}),
            ...(taken.error !== undefined ? { error: taken.error } : {}),
            ...(taken.hint !== undefined ? { hint: taken.hint } : {}),
          };
        }
        const session = deps.sessions.get(id);
        if (isSoftInterrupted(session)) {
          // Terminalize + collect so an omitted-targets re-wait does not keep
          // seeing this id as uncollected / re-deliver soft-interrupt.
          deps.fleetRecords.interrupt(id, session.report);
          const taken = deps.fleetRecords.take(id);
          return {
            agent_id: id,
            status: "interrupted" as const,
            ...(taken?.report !== undefined
              ? { report: taken.report }
              : session.report !== undefined
                ? { report: session.report }
                : {}),
          };
        }
        if (record === undefined) {
          return { agent_id: id, status: "unknown" as const };
        }
        return { agent_id: id, status: "running" as const };
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
    "director, description, wait status, lifecycle, and whether wait_agents already collected it.",
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
        };
      });
      return fleetResult(call.id, JSON.stringify({ agents }));
    },
  });
}
