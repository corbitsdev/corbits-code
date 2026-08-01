/**
 * Task tool: spawn a sub-agent for one self-contained job.
 */

import { tool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import { type } from "arktype";
import type { ReactorEmittedEvent } from "@intx/inference";
import type {
  ToolDefinition,
  ToolResult,
} from "@intx/types/runtime";

import { runtimeSettingsWithCatalog, type ProviderCatalogEntry } from "../config/index.js";
import { formatSubAgentTaskAuthFailureMessage } from "./inference-auth-failure.js";
import type { CapabilityFilter, AgentProfile } from "../agent/profiles.js";
import type { Settings, ProviderTier } from "../config/settings.js";
import {
  resolveSubAgentMaxTurns,
  resolveTier,
  resolveInferenceWithPolicy,
  validateTaskMaxTurns,
} from "../config/settings.js";
import { validateEffort } from "../provider/reasoning-effort.js";
import { isCodexProviderName } from "../config/codex-providers.js";
import type { SubAgentSessionStore } from "./session-store.js";
import {
  buildDispatchBrief,
  type TaskIntent,
} from "./report.js";
import { appendSubAgentParentHints } from "./stop-policy.js";
import {
  classifyBriefSalvage,
  createBriefDispatchLedger,
  fingerprintTaskBrief,
  TURN_BUDGET_STOP_AFTER_DISPATCHES,
} from "./brief-dispatch.js";
import { isSubAgentCancelError } from "./dispose.js";
import { cleanupSubAgentWorktree, createSubAgentWorktree, WorktreeError } from "./worktree.js";
import { generateSessionId } from "../session/index.js";
import { join } from "node:path";
import type {
  NestedDispatchDeps,
  RunSubAgentParams,
  SubAgentProvider,
  SubAgentSandboxDeps,
} from "./types.js";

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
  "maxTurns?": "number",
  "tier?": "'fast' | 'standard' | 'clever'",
});


export const taskToolDefinition: ToolDefinition = {
  name: "task",
  description:
    "Spawn a sub-agent (a short-lived child agent) for one self-contained job. This is not a checklist item — use manage_tasks for your own work list. The sub-agent has the full file, search, and shell toolset, uses this session's permission gate (saved grants and auto mode when eligible; you may be prompted for other consequential actions), and returns a structured report (Summary / Findings / Blockers / Paths). Use it to parallelize exploration (\"map every caller of X\") or hand off a well-scoped implementation so your own context stays focused. Fire several task calls in one turn to run sub-agents in parallel. When launching multiple agents with the same profile, assign each a distinct lens in description and prompt so they do not duplicate work. The sub-agent cannot ask you questions and shares your working tree. Write a clear brief: context = durable background; prompt = actionable goal; goals = optional manage_tasks seeds. Prefer the typed spawn contract so leaves finish without thrashing: intent (explore|implement|review|plan|general), success_criteria (done-when checklist), do_not (scope fence), report_focus (what Findings must cover). After thrash / no-progress / repetition / never-acted salvage, re-dispatching the identical brief (same prompt/agent/intent/success_criteria/do_not) is refused — change the brief to retry; maxTurns or tier alone does not unlock it. Turn-budget salvage may invite a higher maxTurns a few times, then stops recommending re-dispatch until a successful complete resets the same-brief retry budget.",
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "A short label for the sub-agent job (a few words), shown in the Agents strip.",
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
          "Optional concrete done checks. Preferred over free-form prompt alone as the leaf's completion gate.",
      },
      do_not: {
        type: "array",
        items: { type: "string" },
        description: "Optional explicit out-of-scope or forbidden actions for the leaf.",
      },
      report_focus: {
        type: "string",
        description: "Optional hint for what the parent most needs in Findings.",
      },
      agent: {
        type: "string",
        description:
          "Optional agent profile id from search_agents (or .agents/agents/). Profiles specify tier, capability restrictions, and role. Omit for a generic sub-agent on the default provider.",
      },
      maxTurns: {
        type: "number",
        description:
          "Optional inference-turn budget for this worker only (not the parent session limit). Defaults to settings or 30; hard cap 100.",
      },
      tier: {
        type: "string",
        enum: ["fast", "standard", "clever"],
        description:
          "Optional provider tier override for this spawn only (fast | standard | clever). Wins over profile inference and profile tier; fails closed when the tier is unconfigured.",
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
  run: (params: RunSubAgentParams) => Promise<string>;
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
   * Optional wall-clock budget (ms) for each worker this tool spawns. Opt-in
   * only — there is no default leaf death clock. When set, clamped below the
   * outer tool-execution watchdog so a salvage report can return first.
   */
  deadlineMs?: number;
  /**
   * Opt-in: isolate each spawn in its own git worktree branched from the
   * dispatcher's HEAD instead of sharing deps.cwd. Fails closed (see
   * worktree.ts) when deps.cwd is not a git repository or worktree creation
   * fails. Omit (default) to keep today's shared-cwd dispatch.
   */
  useWorktree?: boolean;
};

function taskToolResult(callId: string, content: string): ToolResult {
  const isError = content.startsWith("Error:") || content.startsWith("Error ");
  return { callId, content, ...(isError ? { isError: true } : {}) };
}

export function createTaskTool(deps: TaskToolDeps): AgentTool {
  const run = deps.run;
  // Session-scoped re-dispatch ledger: one per parent task tool instance.
  const briefLedger = createBriefDispatchLedger();
  return tool({
    definition: taskToolDefinition,
    handler: async (call, signal): Promise<ToolResult> => {
      const args = call.arguments;
      const parsed = TaskToolArgs(args);
      if (parsed instanceof type.errors) {
        return taskToolResult(call.id, "Error: task requires description (string) and prompt (string).");
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
        tier: rawTaskTier,
      } = parsed;
      const description = rawDesc.trim();
      const context = rawCtx?.trim();
      const prompt = rawPrompt.trim();
      const goals =
        rawGoals
          ?.map((g) => g.trim())
          .filter((g) => g.length > 0) ?? [];
      const intent = rawIntent as TaskIntent | undefined;
      const successCriteria =
        rawSuccessCriteria
          ?.map((c) => c.trim())
          .filter((c) => c.length > 0) ?? [];
      const doNot =
        rawDoNot
          ?.map((d) => d.trim())
          .filter((d) => d.length > 0) ?? [];
      const reportFocus = rawReportFocus?.trim();
      if (description.length === 0 || prompt.length === 0) {
        return taskToolResult(call.id, "Error: task requires a non-empty description and prompt.");
      }

      let provider: SubAgentProvider =
        typeof deps.provider === "function" ? deps.provider() : deps.provider;
      let capabilities: CapabilityFilter | undefined;
      let systemPromptRole: string | undefined;
      let orchestrator = false;
      let tier: ProviderTier | undefined;
      let profileMaxTurns: number | undefined;
      const diskSettings = deps.settings !== undefined ? resolveDep(deps.settings) : undefined;
      const catalog = deps.catalog !== undefined ? resolveDep(deps.catalog) : undefined;
      // OAuth providers live in the live catalog, not settings.json. Overlay so
      // tier/inference resolution can target Codex/xAI the same way the TUI does.
      const settings =
        catalog !== undefined
          ? runtimeSettingsWithCatalog(diskSettings, catalog)
          : diskSettings;
      const profiles = deps.profiles !== undefined ? resolveDep(deps.profiles) : undefined;

      // Rebuild provider from a resolved provider/model assignment. Shared by
      // task(tier=), profile.inference, and profile.tier so fail-closed effort
      // validation and settings lookup stay consistent.
      const applyResolvedProvider = (
        resolved: {
          provider: string;
          model: string;
          reasoningEffort?: import("../provider/reasoning-effort.js").ReasoningEffort;
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
        }
        const providerSettings = settings.providers[resolved.provider];
        if (providerSettings === undefined) {
          return `Error: ${label} resolved to provider "${resolved.provider}" which is not configured.`;
        }
        const effort = resolved.reasoningEffort ?? provider.reasoningEffort;
        provider = {
          providerName: resolved.provider,
          baseURL: providerSettings.baseURL,
          ...(providerSettings.keyless === true ? { keyless: true } : {}),
          ...(providerSettings.bifrostVirtualKey === true
            ? { bifrostVirtualKey: true }
            : {}),
          ...(providerSettings.apiKey !== undefined
            ? { apiKey: providerSettings.apiKey }
            : {}),
          model: resolved.model,
          ...(effort !== undefined ? { reasoningEffort: effort } : {}),
        };
        return null;
      };

      if (agentId !== undefined && agentId.length > 0) {
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
        if (profile.maxTurns !== undefined) {
          profileMaxTurns = profile.maxTurns;
        }
        if (profile.systemPromptRole !== undefined) {
          systemPromptRole = profile.systemPromptRole;
        }
        // Nested workers (allowOrchestrator: false) cannot re-enter orchestration
        // even if their profile is marked orchestrator — recursion bottoms out.
        if (profile.orchestrator === true && deps.allowOrchestrator !== false) {
          orchestrator = true;
        }
        // Profile inference/tier apply only when task(tier=) is omitted — the
        // caller override wins so a cheap/fast dispatch can still use a clever
        // profile's tools without paying for the profile's pinned model.
        if (rawTaskTier === undefined && settings !== undefined) {
          // Per-agent pinned inference (provider/model/effort) wins over the
          // tier alias when both are declared. Resolution uses policy
          // (mode: pin / agentModelFallback: none) so a forbidden fallback
          // surfaces as a dispatch error rather than silently running on the
          // parent's provider.
          let resolved:
            | { provider: string; model: string; reasoningEffort?: import("../provider/reasoning-effort.js").ReasoningEffort }
            | null = null;
          if (profile.inference !== undefined) {
            const outcome = resolveInferenceWithPolicy(profile.inference, settings);
            if (outcome.kind === "unavailable") {
              return taskToolResult(
                call.id,
                `Error: agent "${agentId}" unavailable: ${outcome.reason}. Set agentModelFallback: "active" (or change the spec mode to "prefer") to fall back to the active session.`,
              );
            }
            if (outcome.kind === "resolved") resolved = outcome.value;
          }
          if (resolved === null && profile.tier !== undefined) {
            const assignment = resolveTier(profile.tier as ProviderTier, settings);
            if (assignment !== null) {
              resolved = assignment;
            }
          }
          if (resolved !== null) {
            const err = applyResolvedProvider(resolved, `agent "${agentId}"`);
            if (err !== null) return taskToolResult(call.id, err);
          }
          if (profile.tier !== undefined) {
            tier = profile.tier as ProviderTier;
          }
        }
      }

      // task(tier=) is highest precedence: overrides profile inference/tier and
      // the parent provider. Fail closed when settings or the tier chain is missing.
      if (rawTaskTier !== undefined) {
        const taskTier = rawTaskTier as ProviderTier;
        if (settings === undefined) {
          return taskToolResult(
            call.id,
            `Error: task tier "${taskTier}" requires configured settings.providers.`,
          );
        }
        const assignment = resolveTier(taskTier, settings);
        if (assignment === null) {
          return taskToolResult(
            call.id,
            `Error: task tier "${taskTier}" is not configured. Set settings.tiers.${taskTier} (or the legacy tier assignment) before dispatching.`,
          );
        }
        const err = applyResolvedProvider(assignment, `task tier "${taskTier}"`);
        if (err !== null) return taskToolResult(call.id, err);
        tier = taskTier;
      }

      let taskMaxTurns: number | undefined;
      if (rawMaxTurns !== undefined) {
        const verdict = validateTaskMaxTurns(rawMaxTurns);
        if (!verdict.ok) {
          return taskToolResult(call.id, `Error: ${verdict.message}`);
        }
        taskMaxTurns = verdict.value;
      }
      const resolvedMaxTurns = resolveSubAgentMaxTurns({
        ...(settings !== undefined ? { settings } : {}),
        ...(profileMaxTurns !== undefined ? { profileMaxTurns } : {}),
        ...(taskMaxTurns !== undefined ? { taskMaxTurns } : {}),
      });

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
      // Parent re-dispatch caps (CL-4343 / CL-5203): admit before session start so
      // a thrash-class refuse never leaves a ghost "running" Agents-strip row.
      const fingerprint = fingerprintTaskBrief({
        prompt,
        ...(agentId !== undefined && agentId.length > 0 ? { agent: agentId } : {}),
        ...(intent !== undefined ? { intent } : {}),
        ...(successCriteria.length > 0 ? { successCriteria } : {}),
        ...(doNot.length > 0 ? { doNot } : {}),
      });
      const admission = briefLedger.admit(fingerprint);
      if (!admission.ok) {
        return taskToolResult(call.id, admission.message);
      }
      const dispatchCount = admission.dispatchCount;

      const agentLabel = agentId !== undefined && agentId.length > 0 ? agentId : "worker";
      const session =
        deps.sessions !== undefined
          ? deps.sessions.start({
              id: call.id,
              description,
              agentId: agentLabel,
              brief,
              ...(deps.parentSessionId !== undefined ? { parentSessionId: deps.parentSessionId } : {}),
            })
          : undefined;
      const recordEvent =
        session !== undefined && deps.sessions !== undefined
          ? (event: ReactorEmittedEvent): void => {
              deps.sessions!.appendEvent(session.id, event);
              deps.onEvent?.(event);
            }
          : deps.onEvent;

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
      if (deps.useWorktree === true) {
        const worktreePath = join(deps.getWorkdirBase(), "worktrees", generateSessionId());
        try {
          const worktree = await createSubAgentWorktree(deps.cwd, worktreePath);
          worktreeCwd = worktree.path;
        } catch (err) {
          // Admit already happened and the strip session may be "running" —
          // release the ledger slot and fail the session so a worktree setup
          // error never burns turn-budget budget or leaves a ghost row.
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
      // Cleanup runs once the sub-agent's report is ready, regardless of
      // outcome, so a cancelled or failed run's worktree is still reclaimed
      // (or preserved with a notice) rather than leaked.
      const finishWithWorktree = async (result: ToolResult): Promise<ToolResult> => {
        if (worktreeCwd === undefined) return result;
        const cleanup = await cleanupSubAgentWorktree(deps.cwd, worktreeCwd);
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
          provider,
          ...(tier !== undefined ? { tier } : {}),
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
          ...(recordEvent !== undefined ? { onEvent: recordEvent } : {}),
          ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {}),
          ...(capabilities !== undefined ? { capabilities } : {}),
          ...(systemPromptRole !== undefined ? { systemPromptRole } : {}),
          ...(orchestrator
            ? { orchestrator: true, nestedDispatch: nestedDispatch! }
            : {}),
          // Nested workers (installed by an orchestrator that already holds a
          // slot) reuse the parent slot rather than acquiring their own.
          ...(deps.allowOrchestrator === false ? { nested: true } : {}),
          maxTurns: resolvedMaxTurns,
          ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
        };
        const result = await run(params);
        // Operator cancel may race after run resolves. Keep strip status cancelled
        // when requested, but never discard a returned body (including salvage).
        const wasCancelled =
          childCtl.signal.aborted ||
          (session !== undefined &&
            deps.sessions?.get(session.id)?.status === "cancelled");
        const salvage = classifyBriefSalvage(result);
        briefLedger.recordOutcome(fingerprint, salvage);
        const hintOptions = {
          dispatchCount,
          turnBudgetStopAfterDispatches: TURN_BUDGET_STOP_AFTER_DISPATCHES,
        };
        if (wasCancelled) {
          if (
            session !== undefined &&
            deps.sessions?.get(session.id)?.status === "running"
          ) {
            deps.sessions.cancel(session.id, cancelReason(childCtl.signal));
          }
const reported = appendSubAgentParentHints(result, hintOptions);
          return finishWithWorktree(
            taskToolResult(call.id, `Sub-agent "${description}" reported:\n\n${reported}`),
          );
        }
        if (session !== undefined) deps.sessions?.complete(session.id, result);
        const reported = appendSubAgentParentHints(result, hintOptions);
        return finishWithWorktree(
          taskToolResult(call.id, `Sub-agent "${description}" reported:\n\n${reported}`),
        );


      } catch (err) {
        if (
          isSubAgentCancelError(err, childCtl.signal) ||
          (session !== undefined &&
            deps.sessions?.get(session.id)?.status === "cancelled")
        ) {
          briefLedger.recordOutcome(fingerprint, "cancelled");
          if (
            session !== undefined &&
            deps.sessions?.get(session.id)?.status === "running"
          ) {
            deps.sessions.cancel(session.id, cancelReason(childCtl.signal));
          }
          return finishWithWorktree(taskToolResult(call.id, cancelledSubAgentMessage(description)));
        }
        // Run never produced a body — undo the admit so turn-budget retry budget
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
        return finishWithWorktree(taskToolResult(call.id, message));
      } finally {
        signal.removeEventListener("abort", onParentAbort);
      }
    },
  });
}

function cancelReason(signal: AbortSignal): string {
  const reason = signal.reason;
  if (typeof reason === "string" && reason.length > 0) return reason;
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  return "Cancelled by operator";
}

function cancelledSubAgentMessage(description: string): string {
  return `Sub-agent "${description}" cancelled by operator.`;
}