/**
 * Sub-agent run lifecycle: provider types, sandbox deps, and runSubAgent.
 */

import { mkdir } from "node:fs/promises";

import { liveTelemetry } from "../telemetry/singleton.js";
import { join } from "node:path";

import {
  defineAgent,
  defineTool,
  createDirectorRegistry,
  defineDirector,
  fromToolRunner,
  stringTool,
} from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import { noopAuditStore, permissiveAuthorize } from "@intx/agent/testing";
import { createOptimizedContextStore } from "../session/optimized-context-store.js";
import { createAgentWithLiveToolDispatch } from "../agent/live-tool-dispatch.js";
import { type } from "arktype";
import { createPosixTools } from "@intx/tools-posix";
import { createDynamicToolRunner } from "../tui/dynamic-tool-runner.js";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { BlobReader, InboundMessage, ToolDefinition } from "@intx/types/runtime";

import { seedPricingMetadataFromCache } from "../cost/pricing-metadata.js";
import { defaultPricingCachePath } from "../cost/pricing-fetcher.js";
import {
  buildBifrostSource,
  buildOpenAISource,
  type ProviderCatalogEntry,
} from "../config/index.js";
import { buildInferenceSourceForRef, buildSubagentSources } from "../config/inference-sources.js";
import { createInferenceDependencies } from "../provider/inference-dependencies.js";
import { advertiseShellGuardTimeout } from "../plugins/shell-guard-plugin.js";
import { advertiseEditFileLineRange } from "../plugins/edit-file-line-range.js";
import { createWebFetchTool } from "../tools/web-fetch.js";
import { createWebSearchTool } from "../tools/web-search.js";
import { buildCorePosixToolPlugins } from "../agent/posix-tool-plugins.js";
import {
  allowDeleteFromCapabilities,
  allowShellFromCapabilities,
  createCodexToolProxies,
  type CodexRunManageTasks,
  type CodexRunTool,
} from "../agent/codex-tool-proxies.js";
import { createCodexReadRawFile } from "../agent/codex-read-raw-file.js";

import { isCodexProviderName } from "../config/codex-providers.js";
import { createCompositeBlobReader } from "../agent/lazy-blob-reader.js";

import { buildSubAgentSystemPrompt } from "../agent/prompts.js";
import { shouldApplyGrokAntiThrash } from "./provider-family.js";
import { resolveModelFamilyPolicy } from "../agent/model-family-policy.js";
import {
  createInterventionLog,
  NOOP_INTERVENTION_SINK,
  type InterventionSink,
} from "./intervention-log.js";
import { normalizeToolDefinitionsForProvider } from "../agent/tool-schema-normalize.js";

import { COMPACTOR_KEEP_RECENT_TURNS, createPruningCompactor } from "../session/compactor.js";
import { createAttachmentRehydrateTransform } from "../session/attachment-store.js";
import { createModelSummarizer } from "../session/summarizer.js";
import { gatherEnvironment } from "../agent/environment.js";
import { generateSessionId } from "../session/index.js";
import { consumeStream } from "../session/stream-consumer.js";
import { createCycleTextRecorder } from "../session/stream-journal.js";
import { refreshInferenceSourceBundle } from "./refresh-inference-source.js";
import type { CapabilityFilter } from "../agent/profiles.js";
import type { Settings } from "../config/settings.js";
import { toolWatchdogFromSettings } from "../config/settings.js";
import { createSearchAgentsTool } from "../agent/agent-search.js";
import { manageTasksDefinition, parseManageTasksArgs } from "../agent/tasks.js";
import { ID_PREFIX } from "../branding.js";
import {
  appendActivitySummary,
  buildDispatchBrief,
  formatSubAgentReport,
  parseSubAgentReport,
  subAgentToolName,
} from "./report.js";
import {
  forcedStopReport,
  partialTextFromEvent,
  preferCompletedSubAgentReply,
  resolveSubAgentCatchOutcome,
  resolveSubAgentDeadlineMs,
  type ForcedStopReason,
} from "./stop-policy.js";
import { SubAgentDirector } from "./nudge-director.js";
import { assertTierMayMountFleetVerb } from "./authority.js";
import { createReadAgentTraceTool } from "./trace-tool.js";
import {
  createSubmitResultState,
  evaluateSubmitResult,
  SUBMIT_RESULT_MAX_CORRECTIONS,
} from "./submit-result.js";
import {
  abortError,
  createSubAgentSpawnRegistryPlugin,
  disposeSubAgentSession,
  isSubAgentCancelError,
  DEFAULT_CLOSE_DEADLINE_MS,
} from "./dispose.js";
import { createTaskTool } from "./task-tool.js";
import { createFleetRecords, createSpawnAgentTool, createWaitAgentsTool } from "./agent-fleet.js";
import {
  createCloseAgentTool,
  createResumeAgentTool,
  createInterruptAgentTool,
  createFollowupTaskTool,
} from "./lifecycle-tools.js";
import { createSubAgentSessionStore } from "./session-store.js";
import type { RunSubAgentParams, RunSubAgentResult, SubAgentProvider } from "./types.js";
import type { TaskIntent } from "./report.js";
import { runWithSubAgentIdentity } from "./identity-context.js";

export type {
  NestedDispatchDeps,
  RunSubAgentParams,
  SubAgentProvider,
  SubAgentSandboxDeps,
} from "./types.js";

/** Content-less inbound used after compact so the reactor re-enters (matches TUI/exec). */
export function buildCompactionContinuationMessage(): InboundMessage {
  return {
    ref: { uid: 0, mailbox: "system" },
    headers: {
      from: "user@local",
      to: ["agent@local"],
      date: new Date().toISOString(),
      messageId: `compact-continue-${Date.now()}@local`,
    },
    flags: [],
    content: "",
    signatureStatus: "missing",
  };
}

// The source used when no profile tier resolves. Exported for tests: the
// parent's provider may need a non-default adapter (Bifrost virtual keys,
// Codex or xAI OAuth profiles speak the Responses API and reject plain Chat
// Completions requests with HTTP 426), so the catalog entry's markers pick
// the adapter exactly as the tiered path does.
export function buildSubAgentPrimarySource(
  provider: SubAgentProvider,
  catalog?: readonly ProviderCatalogEntry[],
  settings?: Settings,
) {
  if (catalog !== undefined) {
    const source = buildInferenceSourceForRef(
      { provider: provider.providerName, model: provider.model },
      {
        sessionId: generateSessionId(),
        catalog,
        ...(provider.reasoningEffort !== undefined
          ? { reasoningEffort: provider.reasoningEffort }
          : {}),
      },
      settings,
    );
    if (source !== null) return { sources: [source], defaultSource: source.id };
  }
  const build = provider.bifrostVirtualKey === true ? buildBifrostSource : buildOpenAISource;
  const primarySource = build({
    id: provider.providerName,
    baseURL: provider.baseURL,
    ...(provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}),
    model: provider.model,
    ...(provider.reasoningEffort !== undefined
      ? { reasoningEffort: provider.reasoningEffort }
      : {}),
  });
  return { sources: [primarySource], defaultSource: primarySource.id };
}

// Web tools are always-on core built-ins in the main session (see
// src/agent/tools.ts); the sub-agent discipline block tells every worker to
// reach for web_fetch/web_search instead of curl/wget, so the tools must
// actually be installed here too. Read-only-network, so no capability filter
// special-case: they pass through applyCapabilityFilter by name like any
// other tool (an "explore" intent that wants a read-only leaf can still
// exclude them explicitly via capabilities.tools).
export function coreSubAgentWebTools(): AgentTool[] {
  return [createWebFetchTool(), createWebSearchTool()];
}

function applyCapabilityFilter(tools: AgentTool[], capabilities: CapabilityFilter): AgentTool[] {
  const nameSet = new Set(capabilities.tools);
  if (capabilities.mode === "exclude") {
    return tools.filter((t) => !nameSet.has(t.definition.name));
  }
  return tools.filter((t) => nameSet.has(t.definition.name));
}

export interface SubAgentRunController {
  signal: AbortSignal;
  deadlineHit: () => boolean;
  /** Abort the run from inside, distinct from parent cancel and deadline. */
  abort: (reason: Error) => void;
  // Normally tears down the timer and the parent-abort forwarding listener.
  // Pass keepParentListener:true for a run that is persisting (retained,
  // clean completion) — otherwise a later parent abort would stop
  // propagating into runController.signal, and closeOnAbort would never
  // fire for the still-open session.
  dispose: (opts?: { keepParentListener?: boolean }) => void;
}

/**
 * Combines an optional caller cancel signal with an optional opt-in wall-clock
 * deadline into one abort signal. The run has a single signal to check while
 * still being able to tell a genuine cancel apart from the deadline firing
 * (deadlineHit()) when picking a forcedStopReport reason. When deadlineMs is
 * omitted, no timer is armed — cancel remains the only bound.
 */
export function createSubAgentRunController(
  parentSignal: AbortSignal | undefined,
  deadlineMs?: number,
): SubAgentRunController {
  const controller = new AbortController();
  let hit = false;
  const onParentAbort = (): void => {
    if (!controller.signal.aborted) controller.abort(parentSignal?.reason);
  };
  if (parentSignal?.aborted === true) {
    controller.abort(parentSignal.reason);
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (deadlineMs !== undefined && deadlineMs > 0) {
    timer = setTimeout(() => {
      // Only mark deadline if we are the abort source. A parent cancel that
      // already aborted must not be relabeled as a deadline hit when the timer
      // fires later (e.g. during stream drain before dispose).
      if (controller.signal.aborted) return;
      hit = true;
      controller.abort(new Error(`sub-agent deadline of ${deadlineMs}ms exceeded`));
    }, deadlineMs);
  }
  return {
    signal: controller.signal,
    deadlineHit: () => hit,
    abort: (reason: Error): void => {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    dispose: (opts?: { keepParentListener?: boolean }): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (opts?.keepParentListener !== true) {
        parentSignal?.removeEventListener("abort", onParentAbort);
      }
    },
  };
}

/** String form of an abort signal's reason (cancel detail), or undefined. */
function abortReasonText(signal: AbortSignal): string | undefined {
  const reason: unknown = signal.reason;
  if (typeof reason === "string" && reason.length > 0) return reason;
  // A bare abort() carries a default AbortError — no operator-written cause.
  if (reason instanceof Error && reason.name !== "AbortError" && reason.message.length > 0) {
    return reason.message;
  }
  return undefined;
}

/**
 * Arm requireEvidence only for the critic director. Greybeard is also
 * intent=review and may spawn-only then envelope; that is not a fake
 * review — do not pull it into the empty-readCounts gate.
 */
export function shouldRequireEvidence(input: {
  intent?: TaskIntent;
  directorId?: string;
}): boolean {
  return input.directorId === "critic";
}

const submitResultDefinition: ToolDefinition = {
  name: "submit_result",
  description:
    "Submit your structured result for this turn. Requires the turn_token from your dispatch " +
    "brief's Turn token section. If a JSON Schema is declared for this job, result is validated " +
    "against it; an invalid submission returns a correction so you can fix and resubmit (capped " +
    `at ${SUBMIT_RESULT_MAX_CORRECTIONS} corrections). This does not replace the markdown report ` +
    "envelope — still finish with it.",
  inputSchema: {
    type: "object",
    properties: {
      turn_token: { type: "string", description: "Turn token from the dispatch brief." },
      result: { description: "The structured result payload." },
    },
    required: ["turn_token", "result"],
  },
};

// Spin up an isolated, autonomous agent loop, hand it one task, and return
// its final report. `params.cwd` is either the dispatcher's own cwd (shared
// mode) or a worktree snapshotted from the dispatcher's last commit
// (isolated mode, see task-tool.ts's useWorktree) — either way this loop
// gets its own posix tool instances and its own git-backed context store so
// the two loops never trample each other's state.
export async function runSubAgent(params: RunSubAgentParams): Promise<RunSubAgentResult> {
  await seedPricingMetadataFromCache({
    cachePath: defaultPricingCachePath(),
  });

  const permissionGate = params.permissionGate;
  // Identifies this dispatch to submit_result so a submission survives
  // only for the turn it was spawned under — a stale call from a redirected
  // orchestrator (echoing an old token) is rejected.
  const turnToken = params.tier === "leaf" ? generateSessionId() : undefined;
  const submitResultState = createSubmitResultState();
  const spawnRegistry = createSubAgentSpawnRegistryPlugin();
  // Child tools resolve spills against the child's own store first, then
  // the parent's: parent tool-output:// URIs handed in the brief must
  // remain readable after spawn, and the child's own spills stay local.
  let childBlobReader: BlobReader | undefined;
  const sessionBlobReader = createCompositeBlobReader(() => childBlobReader, params.getBlobReader);
  const posixTools = createPosixTools({
    cwd: params.cwd,
    blobReader: sessionBlobReader,
    plugins: buildCorePosixToolPlugins({
      cwd: params.cwd,
      permissionGate,
      ...(params.shellTimeout !== undefined ? { shellTimeout: params.shellTimeout } : {}),
      ...(params.shellEnv !== undefined ? { shellEnv: params.shellEnv } : {}),
      readFileGuard: { blobReader: sessionBlobReader },
      extraToolPlugins: [...(params.extraToolPlugins ?? []), spawnRegistry.plugin],
    }),
  });

  let agent: Awaited<ReturnType<typeof createAgentWithLiveToolDispatch>> | null = null;
  let streamPromise: Promise<void> | undefined;
  let closeOnAbort: (() => void) | undefined;
  // Set only on the clean-completion return path; read by the finally block
  // to decide whether a persisted session's teardown is skipped.
  let turnSucceeded = false;
  // Set only on the interrupt_agent path (a dedicated signal fired by the
  // `interrupt` handle below, never runController) — the finally block
  // skips teardown here too, so the agent and its workdir lock stay live
  // for a later followup_task.
  let interruptedKeepAlive = false;
  // Scoped to this run's `agent.send()` call only. Firing it rejects that
  // one send's promise (per Agent.send's documented signal option) without
  // touching agent.close() or runController — the reactor cycle it belongs
  // to keeps running in the background, exactly as the vendored send-queue
  // documents, so a later followup_task's agent.send() simply queues behind
  // it rather than racing a half-torn-down session.
  const interruptController = new AbortController();
  // Declared before try (same reasoning as closeOnAbort above): assigned once
  // requestContinuation/modelFamilyPolicy exist inside the try, but must be
  // visible to the finally block, which is a sibling scope, not a child.
  let stallWatchdog: ReturnType<typeof setInterval> | undefined;
  // Combines the caller's cancel signal with an optional opt-in wall-clock
  // deadline so a leaf that hits the deadline can still return a salvage
  // report. When deadlineMs is omitted, no timer is armed — cancel remains
  // the only bound. Declared before try so finally can dispose.
  // The task tool is exempt from the generic per-tool watchdog (see
  // resolveToolExecutionTimeoutMs), so there is no outer budget to clamp under.
  const resolvedDeadlineMs =
    params.deadlineMs !== undefined
      ? resolveSubAgentDeadlineMs(params.deadlineMs, undefined)
      : undefined;
  const runController = createSubAgentRunController(params.signal, resolvedDeadlineMs);

  try {
    const shellDefaultMs = params.shellTimeout?.defaultMs;
    let tools = fromToolRunner(posixTools).map((tool) => ({
      ...tool,
      definition: advertiseEditFileLineRange(
        advertiseShellGuardTimeout(tool.definition, shellDefaultMs),
      ),
    }));

    tools = [...tools, ...coreSubAgentWebTools()];

    const inherited = params.inheritMcpTools?.() ?? [];
    if (inherited.length > 0) {
      tools = [...tools, ...inherited];
    }

    // Codex apply_patch proxy: mount after posix+web(+mcp), before capability
    // filter, so implement/docs allowlists can keep it when Codex. allowDelete
    // follows whether delete_file is in the leaf capability include list (docs
    // omits it; implement includes it).
    const runTool: CodexRunTool = async (name, args) => {
      const result = await posixTools.run(
        { id: "codex-proxy", name, arguments: args },
        new AbortController().signal,
      );
      return {
        content:
          typeof result.content === "string" ? result.content : JSON.stringify(result.content),
        ...(result.isError === true ? { isError: true } : {}),
      };
    };
    // manage_tasks is not a posix tool — task state here is owned by the
    // director observing manage_tasks tool_calls in the model's own output,
    // not by this handler's return value (see applyManageTasksToolCall in
    // director.ts). This handler only validates, so update_plan's proxy shares
    // it rather than forwarding through posixTools (which has no manage_tasks
    // handler to forward to).
    const runManageTasks: CodexRunManageTasks = async (rawArgs) => {
      const parsed = parseManageTasksArgs(rawArgs);
      if (parsed === null) {
        return {
          content: "Error: manage_tasks requires action ('create' or 'update').",
          isError: true,
        };
      }
      return { content: "Tasks updated." };
    };
    tools = [
      ...tools,
      ...createCodexToolProxies({
        isCodex: isCodexProviderName(params.provider.providerName),
        runTool,
        readRawFile: createCodexReadRawFile(params.cwd, permissionGate),
        runManageTasks,
        allowDelete: allowDeleteFromCapabilities(params.capabilities),
        allowShell: allowShellFromCapabilities(params.capabilities),
      }),
    ];

    if (params.capabilities !== undefined) {
      tools = applyCapabilityFilter(tools, params.capabilities);
    }

    // Every sub-agent is an agent: multi-step jobs get their own manage_tasks
    // checklist. The handler is local to this loop; parent and child never share
    // a list (the parent TUI tracks only the parent's manage_tasks calls).
    tools = [
      ...tools,
      stringTool({
        definition: manageTasksDefinition,
        handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
          const result = await runManageTasks(rawArgs);
          return result.content;
        },
      }),
    ];

    // Typed reporting channel, Tier 3 leaves only. Gated by the existing
    // tier machinery — never invent a parallel check.
    if (params.tier === "leaf") {
      tools = [
        ...tools,
        stringTool({
          definition: submitResultDefinition,
          handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
            const outcome = evaluateSubmitResult({
              turnToken: turnToken!,
              submittedToken: rawArgs.turn_token,
              result: rawArgs.result,
              ...(params.reportType !== undefined ? { outputType: params.reportType } : {}),
              state: submitResultState,
            });
            return outcome.message;
          },
        }),
      ];
    }

    // Orchestrators need task + search_agents installed, not just mentioned in
    // the prompt. Nested dispatch always forbids further orchestration so the
    // tree bottoms out after one hop.
    if (params.orchestrator === true) {
      // Tier enforcement at the mount point, not the prompt, fails closed:
      // an unresolved tier defaults to "leaf" rather than skipping the check,
      // so an AgentProfile outside the closed director set cannot mount
      // task/search_agents just by setting orchestrator: true.
      const tier = params.orchestratorTier ?? "leaf";
      for (const verb of [
        "task",
        "search_agents",
        "read_agent_trace",
        "spawn_agent",
        "wait_agents",
        "close_agent",
        "resume_agent",
        "interrupt_agent",
        "followup_task",
      ]) {
        assertTierMayMountFleetVerb(tier, verb);
      }
      if (params.nestedDispatch === undefined) {
        throw new Error(
          "runSubAgent: orchestrator=true requires nestedDispatch so the task tool can be installed",
        );
      }
      const nd = params.nestedDispatch;
      tools = [
        ...tools,
        createTaskTool({
          permissionGate: nd.permissionGate,
          ...(nd.inheritMcpTools !== undefined ? { inheritMcpTools: nd.inheritMcpTools } : {}),
          ...(nd.shellTimeout !== undefined ? { shellTimeout: nd.shellTimeout } : {}),
          ...(nd.shellEnv !== undefined ? { shellEnv: nd.shellEnv } : {}),
          ...(nd.extraToolPlugins !== undefined ? { extraToolPlugins: nd.extraToolPlugins } : {}),
          cwd: params.cwd,
          getWorkdirBase: nd.getWorkdirBase,
          provider: nd.provider,
          allowOrchestrator: false,
          // Nested workers inherit this composite so they can re-read both the
          // orchestrator's spills and the original parent's.
          getBlobReader: () => sessionBlobReader,
          // Pass the public entry so nested workers still go through the outer
          // slot/refresh path; avoids task-tool importing runSubAgent (cycle).
          run: runSubAgent,
          telemetry: liveTelemetry,
          ...(nd.onEvent !== undefined ? { onEvent: nd.onEvent } : {}),
          ...(nd.onProgress !== undefined ? { onProgress: nd.onProgress } : {}),
          ...(nd.sessions !== undefined ? { sessions: nd.sessions } : {}),
          ...(nd.settings !== undefined ? { settings: nd.settings } : {}),
          ...(nd.catalog !== undefined ? { catalog: nd.catalog } : {}),
          ...(nd.profiles !== undefined ? { profiles: nd.profiles } : {}),
          ...(nd.parentSessionId !== undefined ? { parentSessionId: nd.parentSessionId } : {}),
          ...(nd.useWorktree !== undefined ? { useWorktree: nd.useWorktree } : {}),
          ...(nd.spawnAllowlist !== undefined ? { spawnAllowlist: nd.spawnAllowlist } : {}),
        }),
        ...(nd.profiles !== undefined
          ? [
              createSearchAgentsTool(() => {
                const profiles = nd.profiles;
                return typeof profiles === "function" ? profiles() : (profiles ?? []);
              }),
            ]
          : []),
        // Every worker at every nesting depth is created under the same root
        // workdirBase (nestedDispatch.getWorkdirBase is threaded through
        // unchanged, never rebound to this worker's own dir), so the trace
        // reader's search root is that same function. Descendant-only
        // scoping is enforced inside the tool via assertCanTargetAgent,
        // reusing the fleet nodes SubAgentSessionStore already tracks and
        // this worker's own store id (params.id) — not the disk layout,
        // which is intentionally flat across the whole fleet.
        createReadAgentTraceTool(nd.getWorkdirBase, {
          actorId: params.id,
          tier,
          getNodes: () => nd.sessions?.list() ?? [],
        }),
      ];
      // spawn_agent/wait_agents need a session store as their mailbox;
      // reuse the orchestrator's if it has one, else give this install its
      // own. fleetRecords holds terminal results the session store's
      // display cap would otherwise evict before wait_agents collects them
      // (see agent-fleet.ts).
      const fleetSessions = nd.sessions ?? createSubAgentSessionStore();
      const fleetRecords = createFleetRecords();
      const fleetDeps = {
        permissionGate: nd.permissionGate,
        ...(nd.inheritMcpTools !== undefined ? { inheritMcpTools: nd.inheritMcpTools } : {}),
        ...(nd.shellTimeout !== undefined ? { shellTimeout: nd.shellTimeout } : {}),
        ...(nd.shellEnv !== undefined ? { shellEnv: nd.shellEnv } : {}),
        ...(nd.extraToolPlugins !== undefined ? { extraToolPlugins: nd.extraToolPlugins } : {}),
        cwd: params.cwd,
        getWorkdirBase: nd.getWorkdirBase,
        provider: nd.provider,
        getBlobReader: () => sessionBlobReader,
        run: runSubAgent,
        telemetry: liveTelemetry,
        sessions: fleetSessions,
        fleetRecords,
        ...(nd.onEvent !== undefined ? { onEvent: nd.onEvent } : {}),
        ...(nd.onProgress !== undefined ? { onProgress: nd.onProgress } : {}),
        ...(nd.settings !== undefined ? { settings: nd.settings } : {}),
        ...(nd.catalog !== undefined ? { catalog: nd.catalog } : {}),
      };
      tools = [
        ...tools,
        createSpawnAgentTool(fleetDeps),
        createWaitAgentsTool({ sessions: fleetSessions, fleetRecords }),
        createCloseAgentTool({ sessions: fleetSessions }),
        createResumeAgentTool({ sessions: fleetSessions }),
        createInterruptAgentTool({ sessions: fleetSessions }),
        createFollowupTaskTool({ sessions: fleetSessions }),
      ];
    }

    const environment = await gatherEnvironment(params.cwd);
    const extensions =
      params.systemPromptRole !== undefined ? [params.systemPromptRole] : undefined;
    const toolNames = tools.map((t) => t.definition.name);
    const systemPrompt = buildSubAgentSystemPrompt(extensions, environment, undefined, {
      orchestrator: params.orchestrator === true,
      toolNames,
      grokAntiThrash: shouldApplyGrokAntiThrash({
        providerName: params.provider.providerName,
        model: params.provider.model,
        orchestrator: params.orchestrator === true,
      }),
    });

    // Assigned once the leaf's trace dir exists; the director factory closes
    // over this binding and only fires after that point.
    let interventions: InterventionSink = NOOP_INTERVENTION_SINK;
    // Set by the director when it force-stops via capabilities.reply (the
    // normal agent.send success path) — carried into the returned result
    // instead of being re-derived by parsing the report text.
    let directorForcedStopReason: ForcedStopReason | undefined;
    let agentHandle: Awaited<ReturnType<typeof createAgentWithLiveToolDispatch>> | null = null;
    const requestContinuation = (): void => {
      try {
        agentHandle?.deliver(buildCompactionContinuationMessage());
      } catch {
        // Agent may be closing; a dropped continuation is harmless.
      }
    };

    const modelFamilyPolicy = resolveModelFamilyPolicy({
      providerName: params.provider.providerName,
      model: params.provider.model,
      orchestrator: params.orchestrator === true,
    });

    // Family-gate wire schemas the same way main sessions do (kimi present rewrite).
    // Sub-agent toolsets currently omit `present` (main-session only); normalize is
    // still applied so a future present on leaf tools cannot reintroduce $ref cycles.
    const directorDef = defineDirector({
      id: `${ID_PREFIX}/subagent`,
      configSchema: type({}),
      factory: (_config, _env, agentCtx) => {
        const director = new SubAgentDirector(
          agentCtx.systemPrompt,
          normalizeToolDefinitionsForProvider([...agentCtx.toolDefinitions], {
            providerName: params.provider.providerName,
            model: params.provider.model,
          }),
          requestContinuation,
          modelFamilyPolicy.subAgentStallTimeoutMs,
          Date.now,
          shouldRequireEvidence(params),
        );
        director.observeForcedStop((reason) => {
          directorForcedStopReason = reason;
        });
        director.observeInterventions((event) => {
          interventions(event);
        });
        return director;
      },
    });

    // Directors are pure decide(event, ...) functions with no timer of their
    // own (see checkStallPing on SubAgentDirector), so a silent leaf needs an
    // external nudge to even get a decide() call. Ping the same continuation
    // channel compaction uses at the stall interval; the director only acts on
    // a ping if nothing happened since the last one.
    stallWatchdog = setInterval(
      () => requestContinuation(),
      modelFamilyPolicy.subAgentStallTimeoutMs,
    );
    if (typeof stallWatchdog.unref === "function") stallWatchdog.unref();

    // Every tool call this sub-agent makes runs under its own identity in ALS
    // (description + cwd), so the permission gate can attribute approvals to
    // the agent that raised them (see identity-context.ts).
    const subAgentIdentity = {
      description: params.description,
      cwd: params.cwd,
    };
    const toolsFactory = defineTool({
      id: `${ID_PREFIX}/subagent-tools`,
      // Without the watchdog config, child tool calls run under default budgets
      // and ignore tools.timeoutMs / maxTimeoutMs / waitForApproval settings.
      factory: () => {
        const runner = createDynamicToolRunner(tools, toolWatchdogFromSettings(params.settings));
        return {
          ...runner,
          run: (call, signal) =>
            runWithSubAgentIdentity(subAgentIdentity, () => runner.run(call, signal)),
        };
      },
    });

    // Reuse the caller's session-store id as the on-disk directory name
    // when it is safe as a path segment, so read_agent_trace's descendant
    // check can walk the same parentSessionId chain SubAgentSessionStore
    // already tracks instead of needing a second, disk-only identity
    // scheme.
    const safeRequestedId =
      params.id !== undefined && /^[A-Za-z0-9_-]+$/.test(params.id) ? params.id : undefined;
    const workdir = join(params.workdirBase, "subagents", safeRequestedId ?? generateSessionId());
    await mkdir(workdir, { recursive: true });
    // One record per stop/nudge, with its measured value beside its
    // threshold, written into this leaf's own trace dir.
    interventions = createInterventionLog(workdir, {
      role: params.orchestrator === true ? "orchestrator" : "leaf",
      provider: params.provider.providerName,
      model: params.provider.model,
      family: modelFamilyPolicy.family,
      ...(params.intent !== undefined ? { intent: params.intent } : {}),
    });

    const def = defineAgent({
      id: `${ID_PREFIX}/subagent`,
      systemPrompt,
      tools: [toolsFactory],
      capabilities: [],
      director: directorDef.build({}),
      inference: {
        sources: [{ provider: params.provider.providerName, model: params.provider.model }],
      },
    });

    const storage = await createOptimizedContextStore(workdir);

    const head = { provider: params.provider.providerName, model: params.provider.model };
    const bundle =
      params.settings !== undefined && params.catalog !== undefined
        ? buildSubagentSources({
            settings: params.settings,
            catalog: params.catalog,
            head,
            ...(params.provider.reasoningEffort !== undefined
              ? { reasoningEffort: params.provider.reasoningEffort }
              : {}),
          })
        : buildSubAgentPrimarySource(params.provider, params.catalog, params.settings);
    const inferenceDeps = await createInferenceDependencies();
    const subagentSource =
      bundle.sources.find((s) => s.id === bundle.defaultSource) ?? bundle.sources[0];
    agent = await createAgentWithLiveToolDispatch(def, {
      sources: bundle.sources,
      defaultSource: bundle.defaultSource,
      storage,
      workdir,
      // contextTransforms ride deps: the published @intx/agent forwards deps
      // into reactor assembly verbatim, and the vendored assembly picks the
      // transforms up from there.
      deps: {
        ...inferenceDeps,
        contextTransforms: [createAttachmentRehydrateTransform((key) => storage.readBlob(key))],
      },
      audit: noopAuditStore(),
      authorize: permissiveAuthorize(),
      directors: createDirectorRegistry({
        factories: [directorDef.factory],
        defaultId: `${ID_PREFIX}/subagent`,
      }),
      compactors: {
        "pruning-compactor": createPruningCompactor({
          keepRecentTurns: COMPACTOR_KEEP_RECENT_TURNS,
          summaryMaxChars: 2500,
          // A structured model summary keeps sub-agent context useful across a
          // compaction; the deterministic stub remains the fallback on failure.
          ...(subagentSource !== undefined
            ? {
                summarize: createModelSummarizer({
                  getSource: () => subagentSource,
                  deps: inferenceDeps,
                }),
              }
            : {}),
        }),
      },
    });
    // Tools were built before the agent; bind the child's store now so own spills
    // resolve without dropping the parent fallback.
    childBlobReader = agent.blobReader;
    agentHandle = agent;

    // Collect tool activity for the parent-facing report, and optionally forward
    // progress without dumping the full sub-agent event stream into the chat
    // transcript (which would interleave sub-agent text with the parent turn).
    const toolNamesUsed: string[] = [];
    let lastPartialText = "";
    // Watch the streamed text of the in-flight cycle so a salvage on
    // cancel/deadline has the cycle's tail as its payload, even though no
    // turn boundary has completed yet to carry it.
    const cycleRecorder = createCycleTextRecorder(() => workdir);
    const streamSink = (event: ReactorEmittedEvent): void => {
      const name = subAgentToolName(event);
      if (name !== null) {
        toolNamesUsed.push(name);
        params.onProgress?.({ description: params.description, toolName: name });
      }
      cycleRecorder.handleEvent(event);
      const partial = partialTextFromEvent(event);
      if (partial !== null) lastPartialText = partial;
      params.onEvent?.(event);
    };
    streamPromise = consumeStream(agent.stream(), streamSink);

    // Aborting the send signal only rejects the promise; the child reactor keeps
    // running until close() (same hard-stop rule as the parent in runner.ts).
    closeOnAbort = (): void => {
      void (async () => {
        try {
          await agent?.close();
        } catch {
          // close is idempotent; ignore races with disposeSubAgentSession.
        }
        try {
          await posixTools.dispose();
        } catch {
          // ignore
        }
      })();
    };
    if (runController.signal.aborted) {
      closeOnAbort();
    } else {
      runController.signal.addEventListener("abort", closeOnAbort, { once: true });
    }

    // Hand the caller a bounded, idempotent close it can call at any time
    // (close_agent) — independent of whether this run ends up retained.
    // Aborting first stops a still-running turn before tearing down; on an
    // already-finished turn the abort is a no-op. The timeout races teardown
    // itself so a wedged descendant cannot hang the caller — see dispose.ts
    // for the close()-ordering issue that can stall it.
    if (params.onAgentReady !== undefined) {
      const boundedClose = async (deadlineMs = DEFAULT_CLOSE_DEADLINE_MS): Promise<void> => {
        if (!runController.signal.aborted) runController.abort(new Error("closed by close_agent"));
        const teardown = disposeSubAgentSession({
          signal: runController.signal,
          ...(closeOnAbort !== undefined ? { closeOnAbort } : {}),
          agent,
          ...(streamPromise !== undefined ? { streamPromise } : {}),
          posixTools,
        }).catch(() => {
          // Best-effort: a wedged descendant must not reject the caller.
        });
        await Promise.race([
          teardown,
          new Promise<void>((resolve) => setTimeout(resolve, deadlineMs)),
        ]);
        // The finally block kept the parent-abort forwarding listener alive
        // for a persisted session (see runController.dispose's doc); now that
        // this session is actually closing, tear it down for real.
        runController.dispose();
      };
      // Interrupt only fires interruptController — never runController/
      // close, so it cannot hit the close()-ordering wedge documented in
      // dispose.ts.
      const interrupt = (): void => {
        if (!interruptController.signal.aborted) {
          interruptController.abort(new Error("interrupted by interrupt_agent"));
        }
      };
      // followup_task's payoff — call agent.send() again on the same live
      // agent object, reusing full context rather than starting fresh.
      const followup = async (message: string): Promise<string> => {
        const result = await agent!.send(message, { signal: runController.signal });
        return result.reply.trim().length > 0
          ? result.reply.trim()
          : "Sub-agent finished without a textual result.";
      };
      params.onAgentReady({ close: boundedClose, interrupt, followup });
    }

    const fullPrompt = buildDispatchBrief({
      description: params.description,
      prompt: params.prompt,
      ...(params.context !== undefined ? { context: params.context } : {}),
      ...(params.goals !== undefined && params.goals.length > 0 ? { goals: params.goals } : {}),
      ...(params.intent !== undefined ? { intent: params.intent } : {}),
      ...(params.successCriteria !== undefined && params.successCriteria.length > 0
        ? { successCriteria: params.successCriteria }
        : {}),
      ...(params.doNot !== undefined && params.doNot.length > 0 ? { doNot: params.doNot } : {}),
      ...(params.reportFocus !== undefined && params.reportFocus.trim().length > 0
        ? { reportFocus: params.reportFocus }
        : {}),
      ...(turnToken !== undefined ? { turnToken } : {}),
    });
    const ensureNotAborted = (): void => {
      // Re-read .aborted after await — control-flow narrowing would wrongly
      // treat a pre-send check as permanent.
      if (runController.signal.aborted) throw abortError(runController.signal);
    };
    try {
      ensureNotAborted();
      // Combine the run's own controller with the dedicated interrupt
      // signal so either one stops this send() call, while only
      // runController's abort is wired to closeOnAbort/teardown.
      const sendSignal =
        typeof AbortSignal.any === "function"
          ? AbortSignal.any([runController.signal, interruptController.signal])
          : runController.signal;
      const sendOpts = { signal: sendSignal };
      const fresh = await refreshInferenceSourceBundle(
        bundle.sources,
        bundle.defaultSource,
        params.catalog,
      );
      agent.setSources(fresh.sources, fresh.defaultSource);
      const result = await agent.send(fullPrompt, sendOpts);
      // A successful non-empty reply must not be clobbered by a late cancel that
      // races the completion window — keep the completed report. Empty replies
      // still honor abort so we salvage (or rethrow) rather than fabricating
      // a "no textual result" success over a cancelled run.
      if (preferCompletedSubAgentReply(result.reply) === "honor-abort") {
        ensureNotAborted();
      }
      const reply =
        result.reply.trim().length > 0
          ? result.reply.trim()
          : "Sub-agent finished without a textual result.";
      // Normalize into the structured envelope so the parent always gets a
      // consistent shape even when the model rambling-returns free-form prose.
      const report = formatSubAgentReport(parseSubAgentReport(reply));
      // A clean completion is the only outcome that retains: an aborted or
      // salvaged run below falls through without setting this, so the
      // finally block still tears down for those.
      turnSucceeded = true;
      return {
        report: appendActivitySummary(report, toolNamesUsed),
        ...(directorForcedStopReason !== undefined ? { stopReason: directorForcedStopReason } : {}),
        // Only this path skips teardown below when persist is set — tell
        // the caller so a salvage below is never mistaken for a still-live,
        // resumable agent.
        ...(params.persist === true ? { agentRetained: true } : {}),
      };
    } catch (err) {
      // interrupt_agent fired its own signal, not runController's — check
      // that first so an interrupted send doesn't fall into the cancel/
      // deadline salvage path or rethrow as a bare AbortError.
      if (interruptController.signal.aborted && !runController.signal.aborted) {
        interruptedKeepAlive = true;
        const abortedCycleText = await cycleRecorder.dispose("cancelled", { drain: streamPromise });
        const tail =
          lastPartialText.trim().length > 0 ? lastPartialText : abortedCycleText.slice(-2000);
        return {
          report: appendActivitySummary(
            forcedStopReport("cancelled", tail, "interrupted by interrupt_agent"),
            toolNamesUsed,
          ),
          stopReason: "cancelled",
          interrupted: true,
        };
      }
      if (isSubAgentCancelError(err, runController.signal)) {
        // Close the recorder against the dead cycle before its inference.error
        // arrives: closing at entry stops that auto-flush from mislabeling this
        // salvage with the generic error reason. Draining first lets the sink's
        // own bookkeeping (lastPartialText) catch late tool.start / inference.done
        // events before bare-vs-salvage is decided.
        // Deadline is already known here; a parent cancel is labeled cancelled
        // even if the outcome below resolves to rethrow.
        const abortedCycleText = await cycleRecorder.dispose(
          runController.deadlineHit() ? "deadline" : "cancelled",
          { drain: streamPromise },
        );
        // Deadline always salvages (even with zero output). Cancel after any
        // tools or assistant prose salvages so the parent keeps partial work;
        // pre-progress cancel still surfaces as a bare AbortError.
        const hadProgress = toolNamesUsed.length > 0 || lastPartialText.trim().length > 0;
        const outcome = resolveSubAgentCatchOutcome({
          deadlineHit: runController.deadlineHit(),
          hadProgress,
        });
        if (outcome !== "rethrow") {
          const reason = outcome === "salvage-deadline" ? "deadline" : "cancelled";
          const tail =
            lastPartialText.trim().length > 0 ? lastPartialText : abortedCycleText.slice(-2000);
          const detail =
            reason === "deadline" && resolvedDeadlineMs !== undefined
              ? `${resolvedDeadlineMs}ms elapsed`
              : abortReasonText(runController.signal);
          interventions({
            id: reason,
            class: "stop",
            state: { totalToolCalls: toolNamesUsed.length },
            ...(detail !== undefined ? { detail } : {}),
          });
          return {
            report: appendActivitySummary(forcedStopReport(reason, tail, detail), toolNamesUsed),
            stopReason: reason,
          };
        }
      }
      throw err;
    }
  } finally {
    if (stallWatchdog !== undefined) clearInterval(stallWatchdog);
    // A run keeps its agent alive either because it completed cleanly
    // under persist, or because interrupt_agent fired and the session must
    // stay reusable. Both skip teardown and both need the parent-signal
    // listener kept so a later cancel still reaches them.
    const persisting = (params.persist === true && turnSucceeded) || interruptedKeepAlive;
    // A persisting run must keep the parent-signal forwarding alive (see
    // createSubAgentRunController's dispose doc) — boundedClose (the
    // close_agent handle) fully disposes the runController itself once the
    // session actually tears down.
    runController.dispose({ keepParentListener: persisting });
    // A persisted, cleanly-completed session skips teardown here — it
    // stays open until close_agent (or a later failed/aborted run) tears it
    // down.
    if (!persisting) {
      await disposeSubAgentSession({
        signal: runController.signal,
        ...(closeOnAbort !== undefined ? { closeOnAbort } : {}),
        agent,
        ...(streamPromise !== undefined ? { streamPromise } : {}),
        posixTools,
      });
    }
  }
}
