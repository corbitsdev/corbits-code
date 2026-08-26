/**
 * Task tool: spawn a sub-agent for one self-contained job.
 */

import { tool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import { type } from "arktype";
import type { ReactorEmittedEvent } from "@intx/inference";
import { getLogger } from "@intx/log";
import type { ToolDefinition, ToolResult } from "@intx/types/runtime";

import { LOG_NAMESPACE_ROOT } from "../branding.js";

import { runtimeSettingsWithCatalog, type ProviderCatalogEntry } from "../config/index.js";
import { formatSubAgentTaskAuthFailureMessage } from "./inference-auth-failure.js";
import type { CapabilityFilter, AgentProfile } from "../agent/profiles.js";
import {
  isDirectorId,
  packageToCapabilities,
  resolveDirector,
} from "../agent/directors/registry.js";
import {
  defaultEffortForDirector,
  formatDirectorSystemPrompt,
} from "../agent/directors/identity.js";
import type { DirectorPackage, SubagentTier } from "../agent/directors/types.js";
import type { Settings } from "../config/settings.js";
import { resolveInferenceWithPolicy } from "../config/settings.js";
import {
  resolveEffortForRole,
  validateEffort,
  type ReasoningEffort,
} from "../provider/reasoning-effort.js";
import { isCodexProviderName } from "../config/codex-providers.js";
import { DEFAULT_CANCEL_REASON, type SubAgentSessionStore } from "./session-store.js";
import {
  createFleetRecords,
  createSpawnAgentTool,
  createWaitAgentsTool,
  MAX_WAIT_TIMEOUT_MS,
  type AgentFleetDeps,
  type FleetRecordsHandle,
} from "./agent-fleet.js";
import { buildDispatchBrief, type TaskIntent } from "./report.js";
import { appendSubAgentParentHints, type ForcedStopReason } from "./stop-policy.js";
import {
  classifyBriefSalvage,
  createBriefDispatchLedger,
  fingerprintTaskBrief,
} from "./brief-dispatch.js";
import { createInterventionLog, type InterventionSink } from "./intervention-log.js";
import { detectModelFamily } from "./provider-family.js";
import { isSubAgentCancelError } from "./dispose.js";
import { cleanupSubAgentWorktree, createSubAgentWorktree, WorktreeError } from "./worktree.js";
import { generateSessionId } from "../session/index.js";
import { end, start } from "../perf/index.js";
import { currentTurnId } from "../perf/reactor-spans.js";
import { classifyAgentName } from "../telemetry/classify.js";
import { NOOP_TELEMETRY, type Telemetry } from "../telemetry/index.js";
import { captureSubagentEnd } from "../telemetry/product-events.js";
import { getCurrentTurnTraceId } from "../telemetry/feedback.js";

import { join } from "node:path";
import type {
  NestedDispatchDeps,
  RunSubAgentParams,
  RunSubAgentResult,
  SubAgentProvider,
  SubAgentSandboxDeps,
  SubAgentTelemetryRollup,
} from "./types.js";

const log = getLogger([LOG_NAMESPACE_ROOT, "subagent", "task-tool"]);

export const TaskToolArgs = type({
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

// Deprecated: task() is the fused, blocking spawn+wait primitive.
// Prefer spawn_agent + wait_agents for new call sites — spawn_agent returns
// immediately and wait_agents blocks on whichever workers you need next, so
// multiple workers do not serialize behind one call. task() is not removed —
// much still routes through it — but new work should reach for the split
// verbs first.
export const taskToolDefinition: ToolDefinition = {
  name: "task",
  description:
    'Deprecated: prefer spawn_agent + wait_agents for new call sites (this fused blocking form is kept for compatibility). Spawn a sub-agent (a short-lived child agent) for one self-contained job. This is not a checklist item — use manage_tasks for your own work list. The sub-agent has the full file, search, and shell toolset, uses this session\'s permission gate (saved grants and auto mode when eligible; you may be prompted for other consequential actions), and returns a structured report (Summary / Findings / Blockers / Paths). Use it to parallelize exploration ("map every caller of X") or hand off a well-scoped implementation so your own context stays focused. Fire several task calls in one turn to run sub-agents in parallel. When launching multiple agents with the same profile, assign each a distinct lens in description and prompt so they do not duplicate work. The sub-agent cannot ask you questions. Depending on dispatch configuration it either shares your working tree directly, or runs isolated in its own git worktree snapshotted from your last commit — in the isolated case, any uncommitted or untracked changes in your working tree are excluded. Write a clear brief: context = durable background; prompt = actionable goal; goals = optional manage_tasks seeds. Prefer the typed spawn contract so workers finish without thrashing: intent (explore|implement|review|plan|general), success_criteria (done-when checklist), do_not (scope fence), report_focus (what Findings must cover).',
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description:
          "A short label for the sub-agent job (a few words), shown in the Agents strip.",
      },
      context: {
        type: "string",
        description:
          "Optional durable background (codebase structure, conventions, constraints). Separate from the actionable goal.",
      },
      prompt: {
        type: "string",
        description:
          "The actionable goal: what the sub-agent must accomplish and what to put in its report.",
      },
      goals: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional ordered checklist seeds for the child's own manage_tasks list. Does not affect your manage_tasks list.",
      },
      intent: {
        type: "string",
        enum: ["explore", "implement", "review", "plan", "general"],
        description:
          "Optional spawn intent (explore | implement | review | plan | general). Rendered in the dispatch brief when set; omit for max back-compat.",
      },
      success_criteria: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional concrete done checks. Preferred over free-form prompt alone as the worker's completion gate.",
      },
      do_not: {
        type: "array",
        items: { type: "string" },
        description: "Optional explicit out-of-scope or forbidden actions for the worker.",
      },
      report_focus: {
        type: "string",
        description: "Optional hint for what the parent most needs in Findings.",
      },
      agent: {
        type: "string",
        description:
          "Optional agent profile id from search_agents (or .agents/agents/). Profiles specify capability restrictions and role. Role drives reasoning-effort defaults (orchestrator high, worker medium) unless the profile pins inference.reasoningEffort; parent session effort is inheritance only when the role default is unsupported on the model.",
      },
    },
    required: ["description", "prompt"],
  },
};

function resolveDep<T>(value: T | (() => T)): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

export type TaskToolDeps = SubAgentSandboxDeps & {
  cwd: string;
  getWorkdirBase: () => string;
  // A getter so a live /agent provider/model/effort switch reaches subagents
  // spawned after the change, not just the value captured at startup. A plain
  // value is also accepted for callers with no live switching.
  provider: SubAgentProvider | (() => SubAgentProvider);
  // Required runner — inject runSubAgent in production, a mock in tests.
  // Keeping this required (no default import of run) breaks the run↔task-tool cycle.
  run: (params: RunSubAgentParams) => Promise<RunSubAgentResult>;
  onEvent?: (event: ReactorEmittedEvent) => void;
  onProgress?: (info: { description: string; toolName: string }) => void;
  // When set, each spawn is recorded as an inspectable session (identity,
  // brief, transcript, status) for the TUI enter-session surface. Events are
  // written here only — they are not forwarded into the parent chat transcript.
  sessions?: SubAgentSessionStore;
  settings?: Settings | (() => Settings | undefined);
  catalog?: readonly ProviderCatalogEntry[] | (() => readonly ProviderCatalogEntry[]);
  profiles?: AgentProfile[] | (() => AgentProfile[]);
  // When false, profile.orchestrator is ignored so nested workers cannot
  // themselves become orchestrators. Defaults to true for the primary session.
  allowOrchestrator?: boolean;
  // Set on the nested task tool installed inside an orchestrator sub-agent:
  // the orchestrator's own session id, so workers it spawns record as nested
  // sessions the Agents strip can indent under it.
  parentSessionId?: string;
  /**
   * When set, only these agent/director ids may be spawned. Nested directors
   * (greybeard) pass their package spawn.allowlist; primary omits this so
   * plugin profiles remain reachable.
   */
  spawnAllowlist?: readonly string[];
  /**
   * Optional wall-clock budget (ms) for each worker this tool spawns. Opt-in
   * only — there is no default leaf death clock. The task tool is exempt from
   * the generic tool-execution watchdog, so this deadline is the only
   * wall-clock bound on a worker.
   */
  deadlineMs?: number;

  /**
   * Opt-in: isolate each spawn in its own git worktree branched from the
   * dispatcher's HEAD instead of sharing deps.cwd. Fails closed (see
   * worktree.ts) when deps.cwd is not a git repository or worktree creation
   * fails. Omit (default) to keep today's shared-cwd dispatch.
   */
  useWorktree?: boolean;
  // Records sub-agent starts and outcomes. Injected so the tool has no
  // process-wide dependency; omitting it makes dispatch silent.
  telemetry?: Telemetry;
  /** Shared with spawn_agent/wait_agents when this task tool is fleet-backed. */
  fleetRecords?: FleetRecordsHandle;
};

function taskToolResult(
  callId: string,
  content: string,
  stopReason?: ForcedStopReason,
): ToolResult {
  const isError = content.startsWith("Error:") || content.startsWith("Error ");
  return {
    callId,
    content,
    ...(isError ? { isError: true } : {}),
    // Structured stop-reason side channel: the parent chat director
    // classifies salvage outcomes from this, not from `content`.
    ...(stopReason !== undefined ? { detail: { stopReason } } : {}),
  };
}

type RequiredTaskField = "description" | "prompt";

const REQUIRED_TASK_FIELD_HINTS: Record<RequiredTaskField, string> = {
  description: "a short label for the sub-agent job",
  prompt: "the actionable goal for the worker",
};

/** Truncated echo of a received value so the rejection shows what arrived. */
function receivedFieldPreview(value: string): string {
  const trimmed = value.trim();
  return JSON.stringify(trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed);
}

/**
 * Rejection naming only the actually-bad required fields, echoing the valid
 * one back. A generic "requires description and prompt" hid which field was
 * missing, so models retried the identical call verbatim.
 */
function requiredTaskFieldsError(
  args: Record<string, unknown>,
  bad: readonly RequiredTaskField[],
): string {
  const parts = bad.map((name) => {
    const value = args[name];
    const hint = REQUIRED_TASK_FIELD_HINTS[name];
    if (value === undefined) return `is missing ${name} (string): ${hint}`;
    if (typeof value !== "string") return `has invalid ${name} (must be a string): ${hint}`;
    return `requires a non-empty ${name}: ${hint}`;
  });
  let message = `Error: task ${parts.join(" and ")}.`;
  const good = (Object.keys(REQUIRED_TASK_FIELD_HINTS) as RequiredTaskField[]).filter(
    (name) =>
      !bad.includes(name) &&
      typeof args[name] === "string" &&
      (args[name] as string).trim().length > 0,
  );
  if (good.length > 0) {
    const echo = good
      .map((name) => `${name} ${receivedFieldPreview(args[name] as string)}`)
      .join(" and ");
    message += ` Received ${echo} — keep it and add ${bad.join(" and ")}.`;
  }
  return message;
}

async function runTaskViaFleet(input: {
  callId: string;
  signal: AbortSignal;
  description: string;
  prompt: string;
  context: string | undefined;
  agentId: string | undefined;
  goals: string[];
  intent: TaskIntent | undefined;
  successCriteria: string[];
  doNot: string[];
  reportFocus: string | undefined;
  deps: TaskToolDeps;
  sessions: SubAgentSessionStore;
  fleetRecords: FleetRecordsHandle;
}): Promise<ToolResult> {
  const fleetDeps: AgentFleetDeps = {
    permissionGate: input.deps.permissionGate,
    ...(input.deps.inheritMcpTools !== undefined
      ? { inheritMcpTools: input.deps.inheritMcpTools }
      : {}),
    ...(input.deps.shellTimeout !== undefined ? { shellTimeout: input.deps.shellTimeout } : {}),
    ...(input.deps.shellEnv !== undefined ? { shellEnv: input.deps.shellEnv } : {}),
    ...(input.deps.extraToolPlugins !== undefined
      ? { extraToolPlugins: input.deps.extraToolPlugins }
      : {}),
    ...(input.deps.getBlobReader !== undefined ? { getBlobReader: input.deps.getBlobReader } : {}),
    cwd: input.deps.cwd,
    getWorkdirBase: input.deps.getWorkdirBase,
    provider: input.deps.provider,
    run: input.deps.run,
    sessions: input.sessions,
    fleetRecords: input.fleetRecords,
    persist: false,
    ...(input.deps.parentSessionId !== undefined
      ? { parentSessionId: input.deps.parentSessionId }
      : {}),
    ...(input.deps.spawnAllowlist !== undefined
      ? { spawnAllowlist: input.deps.spawnAllowlist }
      : {}),
    ...(input.deps.allowOrchestrator !== undefined
      ? { allowOrchestrator: input.deps.allowOrchestrator }
      : {}),
    ...(input.deps.useWorktree !== undefined ? { useWorktree: input.deps.useWorktree } : {}),
    ...(input.deps.deadlineMs !== undefined ? { deadlineMs: input.deps.deadlineMs } : {}),
    ...(input.deps.settings !== undefined ? { settings: input.deps.settings } : {}),
    ...(input.deps.catalog !== undefined ? { catalog: input.deps.catalog } : {}),
    ...(input.deps.onEvent !== undefined ? { onEvent: input.deps.onEvent } : {}),
    ...(input.deps.onProgress !== undefined ? { onProgress: input.deps.onProgress } : {}),
    ...(input.deps.telemetry !== undefined ? { telemetry: input.deps.telemetry } : {}),
  };
  const spawn = createSpawnAgentTool(fleetDeps);
  const wait = createWaitAgentsTool({
    sessions: input.sessions,
    fleetRecords: input.fleetRecords,
  });
  if (spawn.kind !== "full" || wait.kind !== "full") {
    return taskToolResult(input.callId, "Error: fleet tools are unavailable.");
  }
  const started = await spawn.handler(
    {
      id: input.callId,
      name: "spawn_agent",
      arguments: {
        description: input.description,
        prompt: input.prompt,
        ...(input.context !== undefined ? { context: input.context } : {}),
        ...(input.agentId !== undefined ? { agent: input.agentId } : {}),
        ...(input.goals.length > 0 ? { goals: input.goals } : {}),
        ...(input.intent !== undefined ? { intent: input.intent } : {}),
        ...(input.successCriteria.length > 0 ? { success_criteria: input.successCriteria } : {}),
        ...(input.doNot.length > 0 ? { do_not: input.doNot } : {}),
        ...(input.reportFocus !== undefined ? { report_focus: input.reportFocus } : {}),
      },
    },
    input.signal,
  );
  const startedText =
    typeof started.content === "string" ? started.content : JSON.stringify(started.content);
  if (started.isError === true || startedText.startsWith("Error:")) {
    return taskToolResult(input.callId, startedText);
  }
  let agentId: string;
  try {
    const parsed = JSON.parse(startedText) as { agent_id?: unknown };
    if (typeof parsed.agent_id !== "string" || parsed.agent_id.length === 0) {
      return taskToolResult(input.callId, "Error: spawn_agent returned no agent_id.");
    }
    agentId = parsed.agent_id;
  } catch (err) {
    log.error("spawn_agent payload was not JSON: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
    return taskToolResult(
      input.callId,
      `Error: spawn_agent returned invalid payload: ${startedText}`,
    );
  }

  while (!input.signal.aborted) {
    const waited = await wait.handler(
      {
        id: `${input.callId}-wait`,
        name: "wait_agents",
        arguments: { targets: [agentId], mode: "all", timeout_ms: MAX_WAIT_TIMEOUT_MS },
      },
      input.signal,
    );
    const waitedText =
      typeof waited.content === "string" ? waited.content : JSON.stringify(waited.content);
    if (waited.isError === true || waitedText.startsWith("Error:")) {
      return taskToolResult(input.callId, waitedText);
    }
    let payload: {
      timed_out?: boolean;
      results?: { status?: string; report?: string; error?: string }[];
    };
    try {
      payload = JSON.parse(waitedText) as typeof payload;
    } catch (err) {
      log.error("wait_agents payload was not JSON: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return taskToolResult(
        input.callId,
        `Error: wait_agents returned invalid payload: ${waitedText}`,
      );
    }
    if (payload.timed_out === true) continue;
    const result = payload.results?.[0];
    if (result === undefined) {
      return taskToolResult(input.callId, `Error: wait_agents returned no result for ${agentId}.`);
    }
    // Cancel must not be misclassified as failed:abort — strip cancel /
    // AbortError leaves fleetRecords as failed with "aborted" while the
    // session store holds cancelled + the operator reason. A cancel that
    // still resolved a salvage body (fleet status done) keeps the report,
    // matching the fused task() race contract.
    const session = input.sessions.get(agentId);
    if (session?.status === "cancelled") {
      if (
        (result.status === "done" || result.status === "interrupted") &&
        typeof result.report === "string" &&
        result.report.length > 0
      ) {
        return taskToolResult(
          input.callId,
          `Sub-agent "${input.description}" reported:\n\n${result.report}`,
        );
      }
      return taskToolResult(
        input.callId,
        cancelledSubAgentMessage(input.description, session.error),
      );
    }
    if (result.status === "failed") {
      const errText = result.error ?? "unknown error";
      // Auth failures already carry the actionable Re-authenticate wording
      // from formatSubAgentTaskAuthFailureMessage (baked in spawn catch).
      if (errText.includes("Re-authenticate")) {
        return taskToolResult(input.callId, `Error: ${errText}`);
      }
      return taskToolResult(
        input.callId,
        `Error: sub-agent "${input.description}" failed: ${errText}`,
      );
    }
    const report = result.report ?? "";
    return taskToolResult(input.callId, `Sub-agent "${input.description}" reported:\n\n${report}`);
  }
  // Parent tool abort must cancel the child — wait_agents itself has no
  // abort side effects (workers stay waitable), so task()'s fused contract
  // owns the cancel here.
  if (input.sessions.get(agentId)?.status === "running") {
    input.sessions.cancel(agentId);
  }
  const cancelled = input.sessions.get(agentId);
  return taskToolResult(
    input.callId,
    cancelledSubAgentMessage(input.description, cancelled?.error),
  );
}

export function createTaskTool(deps: TaskToolDeps): AgentTool {
  const run = deps.run;
  const telemetry = deps.telemetry ?? NOOP_TELEMETRY;
  // Session-scoped re-dispatch ledger: one per parent task tool instance.
  const briefLedger = createBriefDispatchLedger();
  const fleetSessions = deps.sessions;
  const fleetRecords =
    deps.fleetRecords ?? (fleetSessions !== undefined ? createFleetRecords() : undefined);
  // Every completed dispatch gets an outcome record — the log otherwise
  // carries shape and run state but never what the run actually produced.
  // Tagged with the dispatched child's provider/model/family so
  // per-model intervention counts finally have a denominator: the same
  // provider/model this dispatch actually ran under, taken after profile/
  // agent inference resolution — never a name the parent merely intended.
  let outcomeLog: InterventionSink | null = null;
  const recordOutcome = (
    kind: string,
    dispatchCount: number,
    identity: { provider: string; model: string },
  ): void => {
    outcomeLog ??= createInterventionLog(deps.getWorkdirBase(), { role: "parent" });
    const family = detectModelFamily({ providerName: identity.provider, model: identity.model });
    outcomeLog({
      id: "dispatch-outcome",
      class: "outcome",
      outcome: { kind, dispatchCount },
      provider: identity.provider,
      model: identity.model,
      family,
    });
  };
  // Concurrent-lane overlap detection, replacing the static
  // per-package writePaths lock. There is no field in the task() contract a
  // caller uses to declare which files a dispatch will touch, so the only
  // honestly knowable "intended scope" at spawn is the working directory the
  // dispatch will run in — worktree-isolated lanes always get a fresh,
  // disjoint path here, so this can only ever fire in the shared-cwd fallback,
  // which is exactly where two lanes really can stomp each other's writes.
  // Keyed by call.id so a completed lane (removed in the outer finally below)
  // is never mistaken for one still running: sequential dispatches to the
  // same cwd are always clean.
  const activeLanes = new Map<string, { description: string; cwd: string }>();
  let conflictLog: InterventionSink | null = null;
  const recordConflict = (event: Parameters<InterventionSink>[0]): void => {
    conflictLog ??= createInterventionLog(deps.getWorkdirBase(), { role: "parent" });
    conflictLog(event);
  };
  return tool({
    definition: taskToolDefinition,
    handler: async (call, signal): Promise<ToolResult> => {
      const args = call.arguments;
      const parsed = TaskToolArgs(args);
      if (parsed instanceof type.errors) {
        const bad = (["description", "prompt"] as const).filter(
          (name) => typeof args[name] !== "string",
        );
        if (bad.length === 0) {
          return taskToolResult(call.id, `Error: task arguments invalid: ${parsed.summary}`);
        }
        return taskToolResult(call.id, requiredTaskFieldsError(args, bad));
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
      const context = rawCtx?.trim();
      const prompt = rawPrompt.trim();
      const goals = rawGoals?.map((g) => g.trim()).filter((g) => g.length > 0) ?? [];
      const intent = rawIntent as TaskIntent | undefined;
      const successCriteria =
        rawSuccessCriteria?.map((c) => c.trim()).filter((c) => c.length > 0) ?? [];
      const doNot = rawDoNot?.map((d) => d.trim()).filter((d) => d.length > 0) ?? [];
      const reportFocus = rawReportFocus?.trim();
      if (description.length === 0 || prompt.length === 0) {
        const empty = (["description", "prompt"] as const).filter(
          (name) => (name === "description" ? description : prompt).length === 0,
        );
        return taskToolResult(call.id, requiredTaskFieldsError(args, empty));
      }

      // Closed-director task() is spawn_agent + wait_agents. Custom profiles
      // still use the legacy await-run path until spawn grows profile lookup.
      const agentForFleet = typeof args.agent === "string" ? args.agent : undefined;
      const canUseFleet =
        fleetSessions !== undefined &&
        fleetRecords !== undefined &&
        (agentForFleet === undefined || agentForFleet.length === 0 || isDirectorId(agentForFleet));
      if (canUseFleet) {
        return await runTaskViaFleet({
          callId: call.id,
          signal,
          description,
          prompt,
          context,
          agentId,
          goals,
          intent,
          successCriteria,
          doNot,
          reportFocus,
          deps,
          sessions: fleetSessions,
          fleetRecords,
        });
      }

      let provider: SubAgentProvider =
        typeof deps.provider === "function" ? deps.provider() : deps.provider;
      // Snapshot parent effort before profile-inference rebuilds so role-default
      // resolution can fall back to inheritance without reading a mutated provider.
      const parentEffort = provider.reasoningEffort;
      // Explicit profile inference pin (if any). Distinct from the parent
      // snapshot so resolveEffortForRole can apply pin > role > parent.
      let effortPin: ReasoningEffort | undefined;
      let capabilities: CapabilityFilter | undefined;
      let systemPromptRole: string | undefined;
      let orchestrator = false;
      /**
       * Fleet authority tier for this dispatch — forwarded to
       * runSubAgent, which fails closed (denies task/search_agents) when
       * orchestrator is true and this is left undefined or resolves to
       * "leaf". Set alongside `orchestrator = true` in every branch below;
       * never left to default once orchestrator is true.
       */
      let orchestratorTier: SubagentTier | undefined;
      let resolvedDirectorId: string | undefined;
      let resolvedPackage: DirectorPackage | undefined;
      /** Child-package spawn allowlist to forward into nested task (if this worker may spawn). */
      let nestedSpawnAllowlist: readonly string[] | undefined;
      const diskSettings = deps.settings !== undefined ? resolveDep(deps.settings) : undefined;

      const catalog = deps.catalog !== undefined ? resolveDep(deps.catalog) : undefined;
      // OAuth providers live in the live catalog, not settings.json. Overlay so
      // inference resolution can target Codex/xAI the same way the TUI does.
      const settings =
        catalog !== undefined ? runtimeSettingsWithCatalog(diskSettings, catalog) : diskSettings;
      const profiles = deps.profiles !== undefined ? resolveDep(deps.profiles) : undefined;

      // Rebuild provider from a resolved provider/model assignment. Shared by
      // profile.inference so fail-closed effort validation and settings
      // lookup stay consistent.
      const applyResolvedProvider = (
        resolved: {
          provider: string;
          model: string;
          reasoningEffort?: ReasoningEffort;
        },
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
          // Pin is recorded here; final effort is applied after role resolution
          // so a leg without reasoningEffort still gets the role default.
          effortPin = resolved.reasoningEffort;
        }
        const providerSettings = settings.providers[resolved.provider];
        if (providerSettings === undefined) {
          return `Error: ${label} resolved to provider "${resolved.provider}" which is not configured.`;
        }
        // Provider/model swap only — effort is finalized once via
        // resolveEffortForRole (pin > role default > parent) below.
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

      if (agentId !== undefined && agentId.length > 0) {
        // Closed director fleet: resolve package even when profiles
        // are not loaded; profiles may still pin inference for the same id.
        if (isDirectorId(agentId)) {
          const resolved = resolveDirector({ agentId });
          if (!resolved.ok) {
            return taskToolResult(call.id, `Error: ${resolved.error} ${resolved.hint}`);
          }
          const pkg = resolved.package;
          resolvedPackage = pkg;
          resolvedDirectorId = pkg.id;
          systemPromptRole = formatDirectorSystemPrompt(pkg);
          const caps = packageToCapabilities(pkg);
          if (caps !== undefined) capabilities = caps;
          if (pkg.spawn.maySpawn && deps.allowOrchestrator !== false) {
            orchestrator = true;
            orchestratorTier = pkg.tier;
            if (pkg.spawn.allowlist !== undefined && pkg.spawn.allowlist.length > 0) {
              nestedSpawnAllowlist = pkg.spawn.allowlist;
            }
          }
          const profile = profiles?.find((p) => p.id === agentId);

          if (profile?.inference !== undefined && settings !== undefined) {
            const outcome = resolveInferenceWithPolicy(profile.inference, settings);
            if (outcome.kind === "unavailable") {
              return taskToolResult(
                call.id,
                `Error: agent "${agentId}" unavailable: ${outcome.reason}. Set agentModelFallback: "active" (or change the spec mode to "prefer") to fall back to the active session.`,
              );
            }
            if (outcome.kind === "resolved") {
              const err = applyResolvedProvider(outcome.value, `agent "${agentId}"`);
              if (err !== null) return taskToolResult(call.id, err);
            }
          }
        } else {
          // Fail closed: an explicit agent= that cannot be resolved is an error,
          // not a silent fall-through to a generic worker. Silent fall-through
          // made typos and stale ids look like successful generic dispatches.
          if (profiles === undefined) {
            return taskToolResult(
              call.id,
              `Error: agent "${agentId}" requested but no agent profiles are loaded. Omit agent to use a generic sub-agent, or ensure profiles are available.`,
            );
          }
          const profile = profiles.find((p) => p.id === agentId);
          if (profile === undefined) {
            const known = profiles.map((p) => p.id).sort();
            // Point at search_agents (which injects full system prompt bodies) rather
            // than read_file on plugin roots — path-escape blocks those paths by design.
            const hint =
              known.length > 0
                ? ` Known profiles: ${known.join(", ")}. Call search_agents to discover more (results include full system prompt / body; do not read_file plugin paths outside the workspace).`
                : " No profiles are currently loaded. Call search_agents to discover available agents (results include full system prompt / body).";
            return taskToolResult(call.id, `Error: unknown agent profile "${agentId}".${hint}`);
          }
          if (profile.capabilities !== undefined) {
            capabilities = profile.capabilities;
          }
          if (profile.systemPromptRole !== undefined) {
            systemPromptRole = profile.systemPromptRole;
          }
          // Nested workers (allowOrchestrator: false) cannot re-enter orchestration
          // even if their profile is marked orchestrator — recursion bottoms out.
          if (profile.orchestrator === true && deps.allowOrchestrator !== false) {
            orchestrator = true;
            // Fail closed: a profile is outside the closed director
            // set, so orchestrator: true alone does not grant a tier. No
            // profile field opts in; orchestratorTier stays undefined, which
            // runSubAgent treats as "leaf" and denies task/search_agents.
          }
          // Per-agent pinned inference (provider/model/effort), if declared.
          // Resolution uses policy (mode: pin / agentModelFallback: none) so a
          // forbidden fallback surfaces as a dispatch error rather than
          // silently running on the parent's provider.
          if (profile.inference !== undefined && settings !== undefined) {
            const outcome = resolveInferenceWithPolicy(profile.inference, settings);
            if (outcome.kind === "unavailable") {
              return taskToolResult(
                call.id,
                `Error: agent "${agentId}" unavailable: ${outcome.reason}. Set agentModelFallback: "active" (or change the spec mode to "prefer") to fall back to the active session.`,
              );
            }
            if (outcome.kind === "resolved") {
              const err = applyResolvedProvider(outcome.value, `agent "${agentId}"`);
              if (err !== null) return taskToolResult(call.id, err);
            }
          }
        }
      } else if (intent !== undefined) {
        // intent-only dispatch maps to closed directors (no catch-all worker).
        const resolved = resolveDirector({ intent });
        if (!resolved.ok) {
          return taskToolResult(call.id, `Error: ${resolved.error} ${resolved.hint}`);
        }
        const pkg = resolved.package;
        resolvedPackage = pkg;
        resolvedDirectorId = pkg.id;
        systemPromptRole = formatDirectorSystemPrompt(pkg);
        const caps = packageToCapabilities(pkg);
        if (caps !== undefined) capabilities = caps;
        if (pkg.spawn.maySpawn && deps.allowOrchestrator !== false) {
          orchestrator = true;
          orchestratorTier = pkg.tier;
          if (pkg.spawn.allowlist !== undefined && pkg.spawn.allowlist.length > 0) {
            nestedSpawnAllowlist = pkg.spawn.allowlist;
          }
        }
      } else {
        // No catch-all worker: bare task (no agent, no intent) is refused. Reclassify.
        return taskToolResult(
          call.id,
          'Error: No director selected. Pass task(agent=…) for a named director, or task(intent=implement|explore|plan|review). Intent "general" is not a director.',
        );
      }

      // Skywalker is the primary session identity, not a spawned worker.
      if (agentId === "skywalker" || resolvedDirectorId === "skywalker") {
        return taskToolResult(
          call.id,
          "Error: skywalker is the primary session identity, not a spawned worker. Pass task(agent=…) for a specialist (builder, explorer, counsel, critic, …).",
        );
      }

      // Parent director spawn matrix (e.g. greybeard → intern/explorer/critic only).
      if (deps.spawnAllowlist !== undefined && deps.spawnAllowlist.length > 0) {
        const childId =
          agentId !== undefined && agentId.length > 0 ? agentId : (resolvedDirectorId ?? "");
        if (childId.length === 0 || !deps.spawnAllowlist.includes(childId)) {
          const allowed = deps.spawnAllowlist.join(", ");
          return taskToolResult(
            call.id,
            `Error: spawn of "${childId.length > 0 ? childId : "(unresolved)"}" is outside this director's allowlist. Allowed: ${allowed}.`,
          );
        }
      }

      // Role-based effort: pin > package modelRole default > orchestrator/worker > parent.
      // Leaves default to medium (intern: low) so a primary on high/sol does not
      // multiply the latency cliff across every spawned worker.
      {
        const roleDefault =
          resolvedPackage !== undefined ? defaultEffortForDirector(resolvedPackage) : undefined;
        const effort = resolveEffortForRole({
          orchestrator,
          ...(effortPin !== undefined ? { pin: effortPin } : {}),
          ...(roleDefault !== undefined ? { roleDefault } : {}),
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
      const fingerprint = fingerprintTaskBrief({
        prompt,
        ...(agentId !== undefined && agentId.length > 0 ? { agent: agentId } : {}),
        ...(intent !== undefined ? { intent } : {}),
        ...(successCriteria.length > 0 ? { successCriteria } : {}),
        ...(doNot.length > 0 ? { doNot } : {}),
      });
      const dispatchCount = briefLedger.admit(fingerprint).dispatchCount;

      const agentLabel =
        agentId !== undefined && agentId.length > 0 ? agentId : (resolvedDirectorId ?? "worker");
      const session =
        deps.sessions !== undefined
          ? deps.sessions.start({
              id: call.id,
              description,
              agentId: agentLabel,
              brief,
              ...(deps.parentSessionId !== undefined
                ? { parentSessionId: deps.parentSessionId }
                : {}),
            })
          : undefined;
      const recordEvent =
        session !== undefined && deps.sessions !== undefined
          ? (event: ReactorEmittedEvent): void => {
              deps.sessions!.appendEvent(session.id, event);
              deps.onEvent?.(event);
            }
          : deps.onEvent;

      // A dispatch can fail over to a different configured provider/model
      // mid-run (source priority list, `resolveInferenceWithPolicy` builds the
      // primary; the reactor retries the next source on error) — so the
      // provider/model this call resolved before dispatch is only what the
      // parent *intended*. `inference.done` carries the source that actually
      // served each cycle; track the last one seen so the outcome record can
      // prefer it over the resolved-but-possibly-superseded `provider` value.
      let lastCycleSource: { provider: string; model: string } | undefined;
      const onEvent = (event: ReactorEmittedEvent): void => {
        if (event.type === "inference.done") {
          const source = (event.data as { source?: { provider?: string; model?: string } }).source;
          if (
            source !== undefined &&
            typeof source.provider === "string" &&
            typeof source.model === "string"
          ) {
            lastCycleSource = { provider: source.provider, model: source.model };
          }
        }
        recordEvent?.(event);
      };

      const sandbox: SubAgentSandboxDeps = {
        permissionGate: deps.permissionGate,
        ...(deps.inheritMcpTools !== undefined ? { inheritMcpTools: deps.inheritMcpTools } : {}),
        ...(deps.shellTimeout !== undefined ? { shellTimeout: deps.shellTimeout } : {}),
        ...(deps.shellEnv !== undefined ? { shellEnv: deps.shellEnv } : {}),
        ...(deps.extraToolPlugins !== undefined ? { extraToolPlugins: deps.extraToolPlugins } : {}),
        ...(deps.getBlobReader !== undefined ? { getBlobReader: deps.getBlobReader } : {}),
      };
      const nestedDispatch: NestedDispatchDeps | undefined = orchestrator
        ? {
            ...sandbox,
            getWorkdirBase: deps.getWorkdirBase,
            provider: deps.provider,
            // Forward the external sink, not this session's recorder: nested
            // workers record into their own sessions (deps.sessions below),
            // so chaining recordEvent here would replay each grandchild event
            // into the orchestrator's transcript as well.
            ...(deps.onEvent !== undefined ? { onEvent: deps.onEvent } : {}),
            ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {}),
            // Nested workers share the same session store so their transcripts
            // are enterable too; allowOrchestrator is false so they cannot
            // re-orchestrate indefinitely.
            ...(deps.sessions !== undefined ? { sessions: deps.sessions } : {}),
            ...(deps.settings !== undefined ? { settings: deps.settings } : {}),
            ...(deps.catalog !== undefined ? { catalog: deps.catalog } : {}),
            ...(deps.profiles !== undefined ? { profiles: deps.profiles } : {}),
            ...(session !== undefined ? { parentSessionId: session.id } : {}),
            ...(deps.useWorktree !== undefined ? { useWorktree: deps.useWorktree } : {}),
            ...(nestedSpawnAllowlist !== undefined ? { spawnAllowlist: nestedSpawnAllowlist } : {}),
          }
        : undefined;
      // Per-spawn controller so strip cancel and parent stop share one abort
      // path. Parent tool signal links into this controller; registerCancel
      // lets the session store abort without holding the agent handle.
      const childCtl = new AbortController();
      const onParentAbort = (): void => {
        if (!childCtl.signal.aborted) childCtl.abort(signal.reason);
      };
      if (signal.aborted) {
        childCtl.abort(signal.reason);
      } else {
        signal.addEventListener("abort", onParentAbort, { once: true });
      }
      if (session !== undefined) {
        deps.sessions?.registerCancel(session.id, () => {
          if (!childCtl.signal.aborted) childCtl.abort();
        });
      }

      let worktreeCwd: string | undefined;
      let worktreeStashBaseline: readonly string[] | null = [];
      let worktreeHeadAtCreate: string | undefined;
      // Full child wall: worktree setup → run → teardown.
      const turnId = currentTurnId();
      const subagentSpanId = start("subagent", {
        ...(turnId !== null && turnId.length > 0 ? { parentId: turnId } : {}),
        tags: {
          subagent_id: call.id,
          ...(turnId !== null && turnId.length > 0 ? { turn_id: turnId } : {}),
        },
      });
      const subagentStartedAt = Date.now();
      // Profile / director ids are classified: first-party DIRECTOR_IDS (and
      // legacy "worker") report by name; project/plugin profiles become custom.
      // Capture the in-flight parent turn trace at dispatch — getLastTurnTraceId
      // would be the previous completed turn while this tool still runs.
      const agentName = classifyAgentName(agentLabel);
      const parentTraceId = getCurrentTurnTraceId();
      telemetry.capture("subagent_start", { agent_name: agentName });
      let subagentStatus: "completed" | "cancelled" | "failed" = "completed";
      let endRollup: SubAgentTelemetryRollup | undefined;
      let endStopReason: ForcedStopReason | undefined;
      let endModel: string | undefined;

      try {
        if (deps.useWorktree === true) {
          const worktreePath = join(deps.getWorkdirBase(), "worktrees", generateSessionId());
          try {
            const worktree = await createSubAgentWorktree(deps.cwd, worktreePath);
            worktreeCwd = worktree.path;
            worktreeStashBaseline = worktree.stashBaseline;
            worktreeHeadAtCreate = worktree.headAtCreate;
          } catch (err) {
            // Admit already happened and the strip session may be "running" —
            // release the ledger slot and fail the session so a worktree setup
            // error never burns re-dispatch bookkeeping or leaves a ghost row.
            const message =
              err instanceof WorktreeError
                ? err.message
                : `sub-agent worktree setup failed: ${err instanceof Error ? err.message : String(err)}`;
            briefLedger.release(fingerprint);
            if (session !== undefined) deps.sessions?.fail(session.id, message);
            signal.removeEventListener("abort", onParentAbort);
            return taskToolResult(call.id, `Error: ${message}`);
          }
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
        // Cleanup runs once the sub-agent's report is ready, regardless of
        // outcome, so a cancelled or failed run's worktree is still reclaimed
        // (or preserved with a notice) rather than leaked.
        const finishWithWorktree = async (result: ToolResult): Promise<ToolResult> => {
          if (worktreeCwd === undefined) return result;
          const cleanup = await cleanupSubAgentWorktree(deps.cwd, worktreeCwd, {
            stashBaseline: worktreeStashBaseline,
            ...(worktreeHeadAtCreate !== undefined ? { headAtCreate: worktreeHeadAtCreate } : {}),
          });
          if (cleanup.status === "preserved") {
            return { ...result, content: `${result.content}\n\n${cleanup.notice}` };
          }
          return result;
        };

        try {
          const params: RunSubAgentParams = {
            ...sandbox,
            cwd: worktreeCwd ?? deps.cwd,
            workdirBase: deps.getWorkdirBase(),
            // Same id as the SubAgentSessionStore record so read_agent_trace's
            // descendant check (authority.ts assertCanTargetAgent) can reuse the
            // store's parentSessionId chain instead of a second identity scheme.
            ...(session !== undefined ? { id: session.id } : {}),
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
            ...(capabilities !== undefined ? { capabilities } : {}),
            ...(systemPromptRole !== undefined ? { systemPromptRole } : {}),
            ...(resolvedDirectorId !== undefined ? { directorId: resolvedDirectorId } : {}),
            ...(orchestrator
              ? {
                  orchestrator: true,
                  ...(orchestratorTier !== undefined ? { orchestratorTier } : {}),
                  nestedDispatch: nestedDispatch!,
                }
              : {}),
            ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
            // submit_result mount gate: only a resolved Tier 3 leaf
            // director gets tier here, and only if it declared an outputType.
            ...(resolvedPackage !== undefined ? { tier: resolvedPackage.tier } : {}),
            ...(resolvedPackage?.reportContract?.outputType !== undefined
              ? { reportType: resolvedPackage.reportContract.outputType }
              : {}),
          };
          const result = await run(params);
          endRollup = result.telemetry;
          endStopReason = result.stopReason;
          endModel = lastCycleSource?.model ?? provider.model;
          // Operator cancel may race after run resolves. Keep strip status cancelled
          // when requested, but never discard a returned body (including salvage).

          const wasCancelled =
            childCtl.signal.aborted ||
            (session !== undefined && deps.sessions?.get(session.id)?.status === "cancelled");
          const salvage = classifyBriefSalvage({
            ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
            wasCancelled,
          });
          briefLedger.recordOutcome(fingerprint, salvage);
          // Prefer the last provider/model that actually served inference
          // (captured off inference.done above) over the pre-dispatch
          // `provider` this call resolved — a mid-run failover to a backup
          // source means the two can diverge, and the outcome record should
          // describe what the child ran under, not what the parent intended.
          recordOutcome(salvage ?? "clean-complete", dispatchCount, {
            provider: lastCycleSource?.provider ?? provider.providerName,
            model: lastCycleSource?.model ?? provider.model,
          });
          const hintOptions = { dispatchCount };
          if (wasCancelled) {
            subagentStatus = "cancelled";
            if (session !== undefined && deps.sessions?.get(session.id)?.status === "running") {
              deps.sessions.cancel(session.id, cancelReason(childCtl.signal));
            }
            const reported = appendSubAgentParentHints(
              result.report,
              result.stopReason,
              hintOptions,
            );
            return await finishWithWorktree(
              taskToolResult(
                call.id,
                `Sub-agent "${description}" reported:\n\n${reported}`,
                salvage ?? undefined,
              ),
            );
          }
          if (session !== undefined)
            deps.sessions?.complete(session.id, result.report, {
              ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
            });

          const reported = appendSubAgentParentHints(result.report, result.stopReason, hintOptions);
          return await finishWithWorktree(
            taskToolResult(
              call.id,
              `Sub-agent "${description}" reported:\n\n${reported}`,
              salvage ?? undefined,
            ),
          );
        } catch (err) {
          if (
            isSubAgentCancelError(err, childCtl.signal) ||
            (session !== undefined && deps.sessions?.get(session.id)?.status === "cancelled")
          ) {
            subagentStatus = "cancelled";
            briefLedger.recordOutcome(fingerprint, "cancelled");
            if (session !== undefined && deps.sessions?.get(session.id)?.status === "running") {
              deps.sessions.cancel(session.id, cancelReason(childCtl.signal));
            }
            // Prefer the store's recorded reason (strip cancel writes it there
            // before aborting); fall back to the abort signal's reason.
            const reason =
              (session !== undefined ? deps.sessions?.get(session.id)?.error : undefined) ??
              cancelReason(childCtl.signal);
            return await finishWithWorktree(
              taskToolResult(call.id, cancelledSubAgentMessage(description, reason)),
            );
          }
          subagentStatus = "failed";
          // Run never produced a body — undo the admit so re-dispatch bookkeeping
          // is not burned by auth/provider crashes.
          briefLedger.release(fingerprint);
          const authMessage = formatSubAgentTaskAuthFailureMessage(description, err);
          const message =
            authMessage !== null
              ? `Error: ${authMessage}`
              : `Error: sub-agent "${description}" failed: ${err instanceof Error ? err.message : String(err)}`;
          const sessionError = err instanceof Error ? err.message : String(err);
          // fail() prefixes "Error:" on the transcript report entry — pass bare text.
          const failReason = authMessage ?? sessionError;
          if (session !== undefined) deps.sessions?.fail(session.id, failReason);
          return await finishWithWorktree(taskToolResult(call.id, message));
        } finally {
          signal.removeEventListener("abort", onParentAbort);
        }
      } finally {
        activeLanes.delete(call.id);
        end(subagentSpanId);
        captureSubagentEnd(telemetry, {
          agentName,
          status: subagentStatus,
          durationMs: Date.now() - subagentStartedAt,
          ...(endModel !== undefined ? { model: endModel } : { model: provider.model }),
          ...(endStopReason !== undefined ? { stopReason: endStopReason } : {}),
          ...(endRollup !== undefined ? { rollup: endRollup } : {}),
          ...(parentTraceId !== undefined ? { parentTraceId } : {}),
        });

      }

    },
  });
}

function cancelReason(signal: AbortSignal): string {
  const reason = signal.reason;
  if (typeof reason === "string" && reason.length > 0) return reason;
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  return DEFAULT_CANCEL_REASON;
}

function cancelledSubAgentMessage(description: string, reason?: string): string {
  const base = `Sub-agent "${description}" cancelled by operator.`;
  // Only a non-default reason adds signal ("Session cleared", a stop cause…).
  return reason !== undefined && reason !== DEFAULT_CANCEL_REASON
    ? `${base} Stopped: cancelled — ${reason}`
    : base;
}
