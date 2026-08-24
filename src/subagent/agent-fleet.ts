/**
 * spawn_agent / wait_agents (CL-6942): the non-blocking half of fleet
 * dispatch, split out of `task()`'s fused spawn+wait.
 *
 * `task()` (task-tool.ts) remains the fused, blocking primitive and is
 * unchanged. These two verbs let an orchestrator start several workers in
 * one turn (spawn_agent returns immediately) and later block on whichever
 * ones it cares about (wait_agents), instead of one task() call per worker
 * serializing the wait.
 *
 * State lives entirely in the existing SubAgentSessionStore (status/report/
 * error, keyed by session id) — no parallel bookkeeping map. wait_agents'
 * blocking is driven by the store's `subscribe` mailbox raced against a
 * timeout timer; it never polls.
 *
 * Argument shape intentionally mirrors `task()`'s (description/prompt/
 * context/goals/intent/success_criteria/do_not/report_focus/maxTurns) so a
 * caller can swap one for the other. Scope is deliberately narrower than
 * `task()` for this first cut: only closed-director dispatch (`agent=` a
 * director id, or `intent=`) is supported — no custom AgentProfile lookup,
 * no worktree isolation, no nested orchestration, no re-dispatch ledger.
 * Those are `task()`-only for now; nothing here stops adding them later.
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
import { resolveSubAgentMaxTurns, validateTaskMaxTurns } from "../config/settings.js";
import { resolveEffortForRole } from "../provider/reasoning-effort.js";
import { isCodexProviderName } from "../config/codex-providers.js";
import { buildDispatchBrief, type TaskIntent } from "./report.js";
import type { SubAgentSessionStore, SubAgentSessionStatus } from "./session-store.js";
import type { RunSubAgentParams, SubAgentProvider, SubAgentSandboxDeps } from "./types.js";
import { NOOP_TELEMETRY, type Telemetry } from "../telemetry/index.js";
import { classifyAgentName } from "../telemetry/classify.js";

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
  "maxTurns?": "number",
});

export const spawnAgentToolDefinition: ToolDefinition = {
  name: "spawn_agent",
  description:
    "Start a worker agent and return IMMEDIATELY with its agent_id — this never blocks on the worker's completion. Same brief fields as task() (description/prompt/context/goals/intent/success_criteria/do_not/report_focus/maxTurns); pass agent= a director id or intent= (one of explore|implement|review|plan|general). Fire several spawn_agent calls in one turn to start workers in parallel, then use wait_agents to block on whichever ones you need next. Prefer task() when you only need one worker and want its result before doing anything else — spawn_agent+wait_agents earns its keep when you want to start more than one worker without stalling on the first.",
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
      maxTurns: {
        type: "number",
        description: "Optional inference-turn budget for this worker only.",
      },
    },
    required: ["description", "prompt"],
  },
};

const WaitAgentsArgs = type({
  "targets?": "string[]",
  "timeout_ms?": "number",
});

export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const MAX_WAIT_TIMEOUT_MS = 300_000;

export const waitAgentsToolDefinition: ToolDefinition = {
  name: "wait_agents",
  description:
    `Block until any of the given agents (default: every agent you have spawned that is still running) reaches a ` +
    `terminal state, or timeout_ms elapses — whichever comes first. Default timeout ${DEFAULT_WAIT_TIMEOUT_MS}ms, ` +
    `clamped to a ${MAX_WAIT_TIMEOUT_MS}ms max. A timeout is NOT an error and never touches the workers — they keep ` +
    `running exactly as before and remain waitable. Do not call this in a tight zero-progress loop hoping for a ` +
    `different answer: a timeout means "still running", not "try again right away" — either do other useful work ` +
    `first, or call again with a longer timeout_ms. Calling again immediately with the same targets is safe (it is ` +
    `a real timed wait, not a spin) but wastes turns if nothing about the situation has changed.`,
  inputSchema: {
    type: "object",
    properties: {
      targets: {
        type: "array",
        items: { type: "string" },
        description:
          "agent_id values to wait on. Omit to wait on every currently-running spawned agent.",
      },
      timeout_ms: {
        type: "number",
        description: `Max time to block, in ms. Default ${DEFAULT_WAIT_TIMEOUT_MS}, clamped to ${MAX_WAIT_TIMEOUT_MS}.`,
      },
    },
  },
};

export type AgentFleetDeps = SubAgentSandboxDeps & {
  cwd: string;
  getWorkdirBase: () => string;
  provider: SubAgentProvider | (() => SubAgentProvider);
  run: (params: RunSubAgentParams) => Promise<string>;
  sessions: SubAgentSessionStore;
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
function resolveDirectorDispatch(
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
        maxTurns: rawMaxTurns,
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

      let taskMaxTurns: number | undefined;
      if (rawMaxTurns !== undefined) {
        const verdict = validateTaskMaxTurns(rawMaxTurns);
        if (!verdict.ok) return fleetResult(call.id, `Error: ${verdict.message}`);
        taskMaxTurns = verdict.value;
      }
      const settings = deps.settings !== undefined ? resolveDep(deps.settings) : undefined;
      const resolvedMaxTurns = resolveSubAgentMaxTurns({
        ...(settings !== undefined ? { settings } : {}),
        ...(taskMaxTurns !== undefined ? { taskMaxTurns } : {}),
      });

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
      });
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
        maxTurns: resolvedMaxTurns,
      };

      // Fire and forget: this handler must return before the worker finishes.
      // The worker's outcome lands in deps.sessions, which wait_agents reads.
      deps
        .run(params)
        .then((result) => {
          if (childCtl.signal.aborted) return;
          deps.sessions.complete(session.id, result);
        })
        .catch((err) => {
          if (childCtl.signal.aborted) return;
          const message = err instanceof Error ? err.message : String(err);
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
}

function isTerminal(status: SubAgentSessionStatus): boolean {
  return status !== "running";
}

/**
 * Blocks until any of `targets` is terminal, or `timeoutMs` elapses.
 * Driven by the session store's mailbox (`subscribe`), raced against a
 * timer — never polls. Returns without side effects on timeout: the
 * targets are not touched, so a caller can wait again immediately.
 */
async function waitForAnyTerminal(
  sessions: SubAgentSessionStore,
  targets: readonly string[],
  timeoutMs: number,
): Promise<boolean> {
  const alreadyTerminal = targets.some((id) => {
    const s = sessions.get(id);
    return s !== undefined && isTerminal(s.status);
  });
  if (alreadyTerminal) return false;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(timedOut);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    const unsubscribe = sessions.subscribe(() => {
      if (
        targets.some((id) => {
          const s = sessions.get(id);
          return s !== undefined && isTerminal(s.status);
        })
      ) {
        finish(false);
      }
    });
  });
}

export function createWaitAgentsTool(deps: WaitAgentsDeps): AgentTool {
  return tool({
    definition: waitAgentsToolDefinition,
    handler: async (call, _signal): Promise<ToolResult> => {
      const parsed = WaitAgentsArgs(call.arguments);
      if (parsed instanceof type.errors) {
        return fleetResult(call.id, `Error: wait_agents arguments invalid: ${parsed.summary}`);
      }
      const requestedTimeout = parsed.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS;
      const timeoutMs = Math.min(Math.max(requestedTimeout, 0), MAX_WAIT_TIMEOUT_MS);

      const targets =
        parsed.targets !== undefined && parsed.targets.length > 0
          ? parsed.targets
          : deps.sessions
              .list()
              .filter((s) => s.status === "running")
              .map((s) => s.id);

      if (targets.length === 0) {
        return fleetResult(call.id, JSON.stringify({ results: [], timed_out: false }));
      }

      const timedOut = await waitForAnyTerminal(deps.sessions, targets, timeoutMs);

      const results = targets.map((id) => {
        const session = deps.sessions.get(id);
        if (session === undefined) {
          return { agent_id: id, status: "unknown" as const };
        }
        return {
          agent_id: id,
          status: session.status,
          ...(session.report !== undefined ? { report: session.report } : {}),
          ...(session.error !== undefined ? { error: session.error } : {}),
        };
      });

      return fleetResult(call.id, JSON.stringify({ results, timed_out: timedOut }));
    },
  });
}
