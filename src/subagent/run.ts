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
  type SendResult,
} from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import {
  createWorkerAuthorize,
  workerPermissionGate,
} from "../permission/reactor-authorize.js";
import { createSessionStores } from "../session/optimized-context-store.js";
import { createShellOutputFeedMap } from "../session/shell-output-feed.js";
import { createAgentWithLiveToolDispatch } from "../agent/live-tool-dispatch.js";
import { type } from "arktype";
import { createPosixTools } from "@intx/tools-posix";
import { createDynamicToolRunner } from "../agent/dynamic-tool-runner.js";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { BlobReader, ToolDefinition } from "@intx/types/runtime";

import {
  buildBifrostSource,
  buildGoSource,
  buildOpenAISource,
  type ProviderCatalogEntry,
} from "../config/index.js";
import {
  buildInferenceSourceForRef,
  buildSubagentSources,
} from "../config/inference-sources.js";
import { readSourceCredentialMaterial } from "../config/source-credentials.js";
import { sanitizeDiagnosticValue } from "../diagnostic-sanitize.js";
import {
  assembleInferenceBase,
  createAdvertisedToolset,
} from "../session/assemble-runtime.js";
import { advertiseShellGuardTimeout } from "../plugins/shell-guard-plugin.js";
import { advertiseEditFileLineRange } from "../plugins/edit-file-line-range.js";
import { createWebFetchTool } from "../tools/web-fetch.js";
import { createWebSearchTool } from "../tools/web-search.js";
import { buildCorePosixToolPlugins } from "../agent/posix-tool-plugins.js";
import {
  wrapAgentToolsWithResultTruncation,
  type SpillBlobWriter,
} from "../plugins/result-truncation-plugin.js";

import { isOpenCodeGoProvider } from "../../packages/opencode-go/src/index.js";
import { createCompositeBlobReader } from "../agent/lazy-blob-reader.js";

import { buildSubAgentSystemPrompt } from "../agent/prompts.js";
import { shouldApplyGrokAntiThrash } from "./provider-family.js";
import { resolveModelFamilyPolicy } from "../agent/model-family-policy.js";
import { createCorbitsRetryPolicy } from "../agent/retry-policy.js";
import {
  createInterventionLog,
  NOOP_INTERVENTION_SINK,
  type InterventionSink,
} from "./intervention-log.js";
import { canonicalToolName } from "../agent/canonical-tool-name.js";
import { isMcpToolName } from "../mcp/tool-name.js";
import { createApplyPatchTool } from "../agent/apply-patch-tool.js";
import { createWorktreeRootsProvider } from "../permission/worktree-roots.js";
import {
  checkMountedRequiresTools,
  formatCapabilityUnavailable,
} from "./capability-preflight.js";
import {
  advertisedToolName,
  foldFileToolNames,
  foldFileToolDefinitions,
  projectToolDefinitions,
  toolProfileForModel,
  withAuthzParityDefinitions,
} from "../agent/tool-aliases.js";
import {
  advertisedToolNamesForWorker,
  createToolIndex,
  createToolSearchTool,
} from "../agent/tool-search.js";

import {
  buildCompactionContinuationMessage,
  buildShellBackgroundMessage,
  createSessionPruningCompactor,
} from "../session/runtime-assembly.js";
import {
  createBackgroundShellRegistry,
  type BackgroundShellExit,
} from "../shell/background-shell.js";
import { createAttachmentRehydrateTransform } from "../session/attachment-store.js";
import { tryReadPriorHandoffFile } from "../session/compaction-handoff.js";
import { gatherEnvironmentCached } from "../agent/environment.js";
import { generateSessionId } from "../session/index.js";
import { consumeStream } from "../session/stream-consumer.js";
import { createCycleTextRecorder } from "../session/stream-journal.js";
import { onTurnBoundary } from "../agent/reactor-events.js";
import {
  refreshInferenceSourceBundle,
  withContinuationOAuthRefresh,
} from "./refresh-inference-source.js";
import {
  createResolvedProviderFailureError,
  isResolvedProviderFailureError,
} from "../inference-error-message.js";
import type { InferenceErrorLike } from "../inference-gateway-error.js";
import { MAX_BLIND_WAIT_MS } from "../agent/retry-policy.js";
import { createRunEventSettlement } from "./run-event-settlement.js";

import type { CapabilityFilter } from "../agent/profiles.js";
import type { Settings } from "../config/settings.js";
import { toolWatchdogFromSettings } from "../config/settings.js";
import { createSearchAgentsTool } from "../agent/agent-search.js";
import {
  createSkillSearchTool,
  workerSkillSearchDefinition,
} from "../agent/skill-search.js";
import {
  createUseSkillTool,
  workerUseSkillDefinition,
} from "../agent/use-skill.js";
import { discoverSkillsCached } from "../extensions/skills.js";
import { formatAttachedSkillConstraints } from "../agent/directors/attached-skills.js";
import {
  createManageTasksRunner,
  manageTasksDefinition,
} from "../agent/tasks.js";
import { ID_PREFIX } from "../branding.js";
import {
  appendActivitySummary,
  buildDispatchBrief,
  formatSubAgentReport,
  formatTurnTokenNotice,
  parseSubAgentReport,
  subAgentToolName,
} from "./report.js";
import {
  appendSubAgentParentHints,
  forcedStopReport,
  partialTextFromEvent,
  preferCompletedSubAgentReply,
  resolveSubAgentCatchOutcome,
  resolveSubAgentDeadlineMs,
  type ForcedStopReason,
} from "./stop-policy.js";
import {
  EMPTY_THRASH_STATE,
  nextThrashState,
  salvagePathsFromThrash,
} from "./thrash.js";
import { SubAgentDirector } from "./nudge-director.js";
import { getProcessAdmissionQueue } from "./admission.js";
import { assertTierMayMountFleetVerb } from "./authority.js";
import { createReadAgentTraceTool } from "./trace-tool.js";
import {
  createSubmitResultState,
  evaluateSubmitResult,
  resetSubmitResultTurn,
  SUBMIT_RESULT_MAX_CORRECTIONS,
} from "./submit-result.js";
import {
  ASK_DIRECTOR_MAX_BYTES,
  ASK_DIRECTOR_MAX_QUESTIONS,
  createAskDirectorState,
  createDeferredContinuation,
  handleAskDirector,
  resetAskDirectorTurn,
} from "./ask-director.js";
import {
  abortError,
  createSubAgentSpawnRegistryPlugin,
  disposeSubAgentSession,
  isSubAgentCancelError,
  DEFAULT_CLOSE_DEADLINE_MS,
  awaitBoundedTeardown,
} from "./dispose.js";
import {
  createFleetMailbox,
  createSpawnAgentTool,
  createListAgentsTool,
} from "./agent-fleet.js";
import {
  createCloseAgentTool,
  createResumeAgentTool,
  createInterruptAgentTool,
  createSendInputTool,
} from "./lifecycle-tools.js";
import { createSubAgentSessionStore } from "./session-store.js";
import type {
  RunSubAgentParams,
  RunSubAgentResult,
  SubAgentProvider,
  SubAgentTelemetryRollup,
  SubAgentTerminalReason,
} from "./types.js";

import type { TaskIntent } from "./report.js";
import { runWithSubAgentIdentity } from "./identity-context.js";

/**
 * Worker authorization denies without suspending, so Agent.send must settle
 * on "reply" — a parked gate would wedge the worker. If that drifts, the
 * thrown error still carries the correlationId and approval snapshot.
 */
export function assertReplySend(
  result: SendResult,
): asserts result is Extract<SendResult, { type: "reply" }> {
  if (result.type === "reply") return;
  const error = new Error(
    `Sub-agent send returned a suspended result ` +
      `(correlationId=${result.correlationId}` +
      `${result.approvalSnapshot !== undefined ? ", approvalSnapshot present" : ""})`,
  );
  Object.assign(error, {
    suspendedType: result.type,
    correlationId: result.correlationId,
    ...(result.approvalSnapshot !== undefined
      ? { approvalSnapshot: result.approvalSnapshot }
      : {}),
  });
  throw error;
}

// One outer retry after the harness's per-attempt retries give up (3x per
// send, vendor/intx-inference/src/retry-policy.ts). Delay matches the first
// backoff step below. Per-attempt retry runs inside the live send
// (createCorbitsRetryPolicy), never this loop. Never retry after a tool
// started — a second send would replay side effects.
const MAX_OUTER_ATTEMPTS = 2;
const OUTER_RETRY_DELAY_MS = 500;

/**
 * Reap deadline for the session-stream drain on teardown. A worker parked
 * behind a live shell descendant holds `streamPromise` open, so awaiting
 * it unbounded would wedge interrupt/close forever — expiry drops late
 * stream events, matching the shell-guard reap scale (2s), not the 30s
 * close deadline.
 */
const SUBAGENT_STREAM_DRAIN_REAP_MS = 2_000;

function drainStreamWithReapDeadline(
  drain: Promise<void> | undefined,
): Promise<void> {
  if (drain === undefined) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = Promise.race([
    drain.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SUBAGENT_STREAM_DRAIN_REAP_MS);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  return bounded;
}

// Tests inject a shorter outer-retry delay so provider-failure suites do not
// pay the 500ms backoff per retry in wall clock; production keeps the default.
function outerRetryDelayMs(params: RunSubAgentParams): number {
  return params.outerRetryDelayMs ?? OUTER_RETRY_DELAY_MS;
}

function sleepUnlessAborted(
  ms: number,
  signals: readonly AbortSignal[],
): Promise<void> {
  if (ms <= 0 || signals.some((signal) => signal.aborted))
    return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener("abort", done);
      resolve();
    }
    for (const signal of signals)
      signal.addEventListener("abort", done, { once: true });
  });
}

export type {
  NestedDispatchDeps,
  RunSubAgentParams,
  SubAgentProvider,
  SubAgentSandboxDeps,
} from "./types.js";

// Source used when no profile tier resolves. Exported for tests: catalog
// entry markers pick the adapter (Bifrost virtual keys, Codex/xAI OAuth
// profiles speak the Responses API, rejecting Chat Completions with 426).
export function buildSubAgentPrimarySource(
  provider: SubAgentProvider,
  catalog?: readonly ProviderCatalogEntry[],
  settings?: Settings,
) {
  const sessionId = generateSessionId();
  if (catalog !== undefined) {
    const source = buildInferenceSourceForRef(
      { provider: provider.providerName, model: provider.model },
      {
        sessionId,
        catalog,
        ...(provider.reasoningEffort !== undefined
          ? { reasoningEffort: provider.reasoningEffort }
          : {}),
      },
      settings,
    );
    if (source !== null) return { sources: [source], defaultSource: source.id };
  }
  if (
    isOpenCodeGoProvider({
      name: provider.providerName,
      baseURL: provider.baseURL,
    })
  ) {
    const source = buildGoSource({
      id: provider.providerName,
      ...(provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}),
      model: provider.model,
      sessionId,
      ...(provider.reasoningEffort !== undefined
        ? { reasoningEffort: provider.reasoningEffort }
        : {}),
    });
    return { sources: [source], defaultSource: source.id };
  }
  const build =
    provider.bifrostVirtualKey === true
      ? buildBifrostSource
      : buildOpenAISource;
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

// Web tools are main-session built-ins (src/agent/tools.ts); the sub-agent
// discipline block sends workers to web_fetch/web_search instead of
// curl/wget, so install them here too — no capability special-case.
export function coreSubAgentWebTools(
  inherited: readonly AgentTool[] = [],
): AgentTool[] {
  const inheritedNames = new Set(inherited.map((tool) => tool.definition.name));
  return [createWebFetchTool(), createWebSearchTool()].filter(
    (tool) => !inheritedNames.has(tool.definition.name),
  );
}

/**
 * Capability allowlist/exclude over the assembled worker tool set, with
 * on-demand inherited-MCP mounting.
 *
 * `mcp__*` tools mount only when stamped (`requiresTools` or a
 * `capabilities.tools` allowlist) or inherited via `inheritedMcpTools` when
 * no narrower constraint applies; a stamp narrows inheritance to the
 * stamped names. Unstamped `mcp__*` names never mount, and an explicit
 * exclude still withholds a requested live tool (surfacing as a stale
 * snapshot, normally pre-empted by the dispatch preflight).
 */
export function applyCapabilityFilter(
  tools: AgentTool[],
  capabilities: CapabilityFilter | undefined,
  requiresTools?: readonly string[] | undefined,
  inheritedMcpTools?: readonly string[] | undefined,
): AgentTool[] {
  const required = new Set(
    (requiresTools ?? []).map((name) => canonicalToolName(name)),
  );
  const inherited = new Set(
    (inheritedMcpTools ?? []).map((name) => canonicalToolName(name)),
  );
  if (capabilities === undefined) {
    if (required.size === 0) {
      return tools.filter((t) => {
        const name = canonicalToolName(t.definition.name);
        if (!isMcpToolName(name)) return true;
        return inherited.has(name);
      });
    }
    return tools.filter((t) => {
      const name = canonicalToolName(t.definition.name);
      if (isMcpToolName(name)) return required.has(name);
      return true;
    });
  }
  const engines = new Set(
    capabilities.tools.map((name) => canonicalToolName(name)),
  );
  if (capabilities.mode === "exclude") {
    return tools.filter((t) => {
      const name = canonicalToolName(t.definition.name);
      if (isMcpToolName(name)) return required.has(name) && !engines.has(name);
      return !engines.has(name);
    });
  }
  return tools.filter((t) => {
    const name = canonicalToolName(t.definition.name);
    if (isMcpToolName(name)) return required.has(name) || engines.has(name);
    return engines.has(name);
  });
}

export interface SubAgentRunController {
  signal: AbortSignal;
  deadlineHit: () => boolean;
  /** Abort the run from inside, distinct from parent cancel and deadline. */
  abort: (reason: Error) => void;
  // Tears down the timer and the parent-abort forwarding listener. Pass
  // keepParentListener:true for a persisting run — otherwise a later parent
  // abort stops reaching runController and closeOnAbort never fires.
  dispose: (opts?: { keepParentListener?: boolean }) => void;
}

/**
 * Merges the caller's cancel signal with an optional wall-clock deadline
 * into one abort signal, so salvage can tell a genuine cancel apart from
 * the deadline firing (deadlineHit()). No timer when deadlineMs is
 * omitted.
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
      // Mark deadline only if we are the abort source; a parent cancel must
      // not be relabeled as a deadline hit when the timer fires later.
      if (controller.signal.aborted) return;
      hit = true;
      controller.abort(
        new Error(`sub-agent deadline of ${deadlineMs}ms exceeded`),
      );
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
  if (
    reason instanceof Error &&
    reason.name !== "AbortError" &&
    reason.message.length > 0
  ) {
    return reason.message;
  }
  return undefined;
}

/** Findings payload for cancel/deadline salvage: accumulated prose, then
 * the last turn-boundary text, then the in-flight cycle tail. */
function salvageFindingsText(
  accumulatedProse: string,
  lastPartialText: string,
  abortedCycleText: string,
): string {
  const prior = accumulatedProse.trim();
  if (prior.length > 0) return prior;
  const last = lastPartialText.trim();
  if (last.length > 0) return last;
  return abortedCycleText.slice(-2000);
}

/**
 * Arm requireEvidence only for the reviewer director.
 */
export function shouldRequireEvidence(input: {
  intent?: TaskIntent;
  directorId?: string;
}): boolean {
  return input.directorId === "reviewer";
}

/**
 * Arm plan-substance Findings on planner or intent=plan.
 */
export function shouldRequirePlanSubstance(input: {
  intent?: TaskIntent;
  directorId?: string;
}): boolean {
  return input.intent === "plan" || input.directorId === "planner";
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
      turn_token: {
        type: "string",
        description: "Turn token from the dispatch brief.",
      },
      result: {
        type: "object",
        additionalProperties: true,
        description: "The structured result payload.",
      },
    },
    required: ["turn_token", "result"],
  },
};

const askDirectorDefinition: ToolDefinition = {
  name: "ask_director",
  description:
    "Ask the spawning director when the dispatch brief is genuinely ambiguous. " +
    "You cannot reach the operator. One pending question at a time; " +
    `at most ${ASK_DIRECTOR_MAX_QUESTIONS} questions per turn; ` +
    `${ASK_DIRECTOR_MAX_BYTES} byte cap. The director answers with send_input (soft). ` +
    "For a denied tool call, reference only the grant requestId from the deny " +
    "message — the harness-owned envelope carries the exact call, so repeating " +
    "tool arguments here grants nothing.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question for the spawning director (non-empty).",
      },
      grant_request_id: {
        type: "string",
        description:
          "Grant request id quoted from the deny reason; binds this ask to its own denial.",
      },
    },
    required: ["question"],
  },
};

// Spin up an isolated agent loop for one task and return its final report.
// `params.cwd` is the dispatcher's cwd (shared mode) or a worktree from its
// last commit (isolated mode) — each loop gets its own posix tools and
// git-backed context store, so the two never trample each other's state.
export async function runSubAgent(
  params: RunSubAgentParams,
): Promise<RunSubAgentResult> {
  const startedAt = Date.now();
  const telemetryRollup: SubAgentTelemetryRollup = {
    turn_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    tool_call_count: 0,
    tool_error_count: 0,
  };
  let terminalReason: SubAgentTerminalReason = "error";
  let errorCount = 0;
  const settlementState = { latestModel: params.provider.model };

  try {
    const result = await runSubAgentInner(
      params,
      telemetryRollup,
      settlementState,
    );
    terminalReason = result.stopReason ?? "complete";
    return result;
  } catch (error) {
    errorCount = 1;
    if (isSubAgentCancelError(error, params.signal))
      terminalReason = "cancelled";
    throw error;
  } finally {
    try {
      params.onRunSettled?.(
        Object.freeze({
          ...telemetryRollup,
          error_count: errorCount,
          duration_ms: Date.now() - startedAt,
          model: settlementState.latestModel,
          terminal_reason: terminalReason,
        }),
      );
    } catch {
      // Settlement is observational and must not change the run's outcome.
    }
  }
}

async function runSubAgentInner(
  params: RunSubAgentParams,
  telemetryRollup: SubAgentTelemetryRollup,
  settlementState: { latestModel: string },
): Promise<RunSubAgentResult> {
  // Fleet-spawned workers skip the pricing-cache seed re-read; the parent
  // runtime already applied the process seed at boot.
  const inferenceDeps = await assembleInferenceBase(undefined, {
    ...(params.skipPricingSeed === true ? { skipPricingSeed: true } : {}),
  });

  // Session id the parent observes (params.id); falls back to a local id
  // without a fleet caller. Denied-call envelopes are keyed by this id.
  let workerGrantSessionId: string | undefined =
    params.id !== undefined && /^[A-Za-z0-9_-]+$/.test(params.id)
      ? params.id
      : undefined;
  const permissionGate = workerPermissionGate(params.permissionGate, {
    sessionId: () => workerGrantSessionId,
  });
  let turnToken = params.tier === "leaf" ? generateSessionId() : undefined;
  const submitResultState = createSubmitResultState();
  const askDirectorState = createAskDirectorState();
  const compactContinue = createDeferredContinuation();
  let deliverCompactContinue = (): void => undefined;
  const spawnRegistry = createSubAgentSpawnRegistryPlugin();
  // Assigned once the agent handle exists; before that (or after close) a
  // completion is dropped, matching the continuation contract.
  let backgroundExitSink: ((exit: BackgroundShellExit) => void) | null = null;
  const backgroundShells = createBackgroundShellRegistry({
    onExit: (exit) => backgroundExitSink?.(exit),
  });
  // A worker whose capability filter drops run_shell has no bash to detach
  // from; the getter stays live so the filter below can unwire it first.
  let backgroundShellsMounted = true;
  // read_file PDF diagnosis asks whether this worker can run pdftotext via
  // bash; flip with backgroundShellsMounted when the filter unmounts shell.
  let hostCommandsMounted = true;
  // Child tools resolve spills against the child's own store first, then
  // the parent's: tool-output:// URIs handed in the brief stay readable
  // after spawn. Writer/context dir bind after createSessionStores, same
  // late-bind as the primary getBlobWriter.
  let childBlobReader: BlobReader | undefined;
  let childBlobWriter: SpillBlobWriter | undefined;
  let childContextDir: string | undefined;
  // Per-call live shell tails for this worker's transcript; nothing polls them
  // unless a transcript host does (silent degradation).
  const childShellOutputFeed = createShellOutputFeedMap();
  const sessionBlobReader = createCompositeBlobReader(
    () => childBlobReader,
    params.getBlobReader,
  );
  const posixTools = createPosixTools({
    cwd: params.cwd,
    blobReader: sessionBlobReader,
    plugins: buildCorePosixToolPlugins({
      cwd: params.cwd,
      permissionGate,
      ...(params.shellTimeout !== undefined
        ? { shellTimeout: params.shellTimeout }
        : {}),
      ...(params.shellEnv !== undefined ? { shellEnv: params.shellEnv } : {}),
      ...(params.secretGuardExtraDeniedPaths !== undefined
        ? { secretGuardExtraDeniedPaths: params.secretGuardExtraDeniedPaths }
        : {}),
      readFileGuard: {
        blobReader: sessionBlobReader,
        canExecuteHostCommands: () => hostCommandsMounted,
      },
      getBackgroundShellRegistry: () =>
        backgroundShellsMounted ? backgroundShells : undefined,
      getShellOutputFeeds: () => childShellOutputFeed,
      getBlobWriter: () => childBlobWriter,
      getContextDir: () => childContextDir,
      extraToolPlugins: [
        ...(params.extraToolPlugins ?? []),
        spawnRegistry.plugin,
      ],
    }),
  });

  let agent: Awaited<
    ReturnType<typeof createAgentWithLiveToolDispatch>
  > | null = null;
  let streamPromise: Promise<void> | undefined;
  let closeOnAbort: (() => void) | undefined;
  // Set on the clean-completion path; the finally block reads it to decide
  // whether a persisted session's teardown is skipped.
  let turnSucceeded = false;
  // Set on the interrupt_agent path (`interrupt` handle's signal, never
  // runController) — the finally block skips teardown so the agent and its
  // workdir lock stay live for a later resume_agent.
  let interruptedKeepAlive = false;
  // Scoped to one `agent.send()` call: rejects only that send's promise,
  // never agent.close() or runController — the reactor keeps running, so a
  // later resume_agent queues behind it. Recreated per followup so a prior
  // abort cannot reject the next turn.
  let interruptController = new AbortController();
  // Declared before try (like closeOnAbort): assigned once inside the try,
  // but must be visible to the finally block, a sibling scope, not a child.
  let stallWatchdog: ReturnType<typeof setInterval> | undefined;
  // Wall-clock bound so a leaf that hits it can still return a salvage
  // report; resolved before try so finally can dispose. spawn_agent is
  // exempt from the per-tool watchdog (resolveToolExecutionTimeoutMs), so
  // no outer budget clamps it.
  const resolvedDeadlineMs =
    params.deadlineMs !== undefined
      ? resolveSubAgentDeadlineMs(params.deadlineMs, undefined)
      : undefined;
  const runController = createSubAgentRunController(
    params.signal,
    resolvedDeadlineMs,
  );
  const sendAbortSignal = (): AbortSignal =>
    typeof AbortSignal.any === "function"
      ? AbortSignal.any([runController.signal, interruptController.signal])
      : runController.signal;

  try {
    const shellTimeout = params.shellTimeout;
    let tools = fromToolRunner(posixTools).map((tool) => ({
      ...tool,
      definition: advertiseEditFileLineRange(
        advertiseShellGuardTimeout(
          tool.definition,
          shellTimeout?.defaultMs,
          shellTimeout?.maxMs,
        ),
      ),
    }));

    const inherited = params.inheritMcpTools?.(permissionGate) ?? [];
    tools = [...tools, ...coreSubAgentWebTools(inherited)];

    if (inherited.length > 0) {
      tools = [...tools, ...inherited];
    }

    const runManageTasks = createManageTasksRunner();
    // Every worker mounts skill_search + use_skill, scoped to the
    // dispatch's allowedSkillNames, before the capability filter so
    // allowlists keep them like any named tool. The scope cannot widen —
    // use_skill refuses names outside the allowlist.
    const modelFamilyPolicy = resolveModelFamilyPolicy({
      providerName: params.provider.providerName,
      model: params.provider.model,
      orchestrator: params.orchestrator === true,
      ...(params.directorId !== undefined
        ? { directorId: params.directorId }
        : {}),
    });
    const skillDirs = [...(params.skillDirs ?? [])];
    // Reuse the dispatcher's catalog when the lane shares its cwd, else the
    // cached discovery (repeat spawns skip the rescan). Copies isolate workers.
    const skillSnapshot =
      params.skills !== undefined
        ? [...params.skills]
        : await discoverSkillsCached(params.cwd, skillDirs);
    tools = [
      ...tools,
      createSkillSearchTool({
        skills: skillSnapshot,
        definition: workerSkillSearchDefinition,
        ...(params.allowedSkillNames !== undefined
          ? { allowedNames: params.allowedSkillNames }
          : {}),
      }),
      createUseSkillTool(
        params.cwd,
        skillDirs,
        liveTelemetry,
        params.allowedSkillNames,
        workerUseSkillDefinition,
        params.attachedSkills,
      ),
    ];

    tools = applyCapabilityFilter(
      tools,
      params.capabilities,
      params.requiresTools,
      inherited
        .map((tool) => canonicalToolName(tool.definition.name))
        .filter((name) => isMcpToolName(name)),
    );
    if (
      toolProfileForModel(params.provider) === "gpt" &&
      tools.some((t) =>
        ["write_file", "edit_file", "delete_file"].includes(
          canonicalToolName(t.definition.name),
        ),
      )
    ) {
      tools = [
        ...tools,
        createApplyPatchTool(params.cwd, {
          allowOutside: () => permissionGate.getSkipPermissions(),
          rootsProvider: createWorktreeRootsProvider(params.cwd),
          ...(params.secretGuardExtraDeniedPaths !== undefined
            ? { extraDeniedPaths: params.secretGuardExtraDeniedPaths }
            : {}),
        }),
      ];
    }
    hostCommandsMounted = tools.some(
      (tool) => canonicalToolName(tool.definition.name) === "run_shell",
    );
    backgroundShellsMounted = hostCommandsMounted;

    // Every sub-agent gets its own manage_tasks checklist. The handler is
    // local to this loop; parent and child never share a list.
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
      if (turnToken === undefined) {
        throw new Error("leaf dispatch is missing a turn token");
      }
      tools = [
        ...tools,
        stringTool({
          definition: submitResultDefinition,
          handler: async (
            rawArgs: Record<string, unknown>,
          ): Promise<string> => {
            // Read the live binding, not the dispatch-time value: steering
            // rotates turnToken, so an old-token submission is stale.
            const currentToken = turnToken;
            if (currentToken === undefined) {
              return "Error: this run has no turn token, so submit_result cannot verify freshness.";
            }
            const outcome = evaluateSubmitResult({
              turnToken: currentToken,
              submittedToken: rawArgs.turn_token,
              result: rawArgs.result,
              ...(params.reportType !== undefined
                ? { outputType: params.reportType }
                : {}),
              state: submitResultState,
            });
            return outcome.message;
          },
        }),
        stringTool({
          definition: askDirectorDefinition,
          handler: async (
            rawArgs: Record<string, unknown>,
            signal: AbortSignal,
          ): Promise<string> => {
            const port = params.askDirectorPort;
            if (port === undefined) {
              return (
                "Error: ask_director has no director mailbox for this run and cannot suspend. " +
                "Record the question under Blockers and finish with the markdown report envelope."
              );
            }
            try {
              return await handleAskDirector({
                question: rawArgs.question,
                grantRequestId: rawArgs.grant_request_id,
                state: askDirectorState,
                port,
                signal,
              });
            } finally {
              compactContinue.flush(askDirectorState, deliverCompactContinue);
            }
          },
        }),
      ];
    }

    // Orchestrators need fleet tools installed, not just mentioned. Nested
    // dispatch forbids further orchestration, so the tree bottoms out after
    // one hop; search_agents stays orchestrator-tier only.
    if (params.orchestrator === true) {
      // Tier enforcement at the mount point fails closed: an unresolved tier
      // defaults to "leaf", so a profile outside the director set cannot
      // mount fleet verbs by setting orchestrator: true.
      const tier = params.orchestratorTier ?? "leaf";
      const mayDiscoverFleet = tier === "orchestrator";
      for (const verb of [
        ...(mayDiscoverFleet ? (["search_agents"] as const) : []),
        "read_agent_trace",
        "spawn_agent",
        "list_agents",
        "close_agent",
        "resume_agent",
        "interrupt_agent",
        "send_input",
      ]) {
        assertTierMayMountFleetVerb(tier, verb);
      }
      if (params.nestedDispatch === undefined) {
        throw new Error(
          "runSubAgent: orchestrator=true requires nestedDispatch so fleet tools can be installed",
        );
      }
      const nd = params.nestedDispatch;
      const fleetSessions =
        nd.sessions ??
        createSubAgentSessionStore({
          admission: params.admission ?? getProcessAdmissionQueue(),
        });
      const fleetRecords = createFleetMailbox(fleetSessions);
      tools = [
        ...tools,
        ...(mayDiscoverFleet && nd.profiles !== undefined
          ? [
              createSearchAgentsTool(() => {
                const profiles = nd.profiles;
                return typeof profiles === "function"
                  ? profiles()
                  : (profiles ?? []);
              }),
            ]
          : []),
        // Every worker at any depth keeps the same root workdirBase
        // (never rebound to its own dir), so the trace reader searches that
        // root. Descendant scoping is enforced via assertCanTargetAgent on
        // fleet nodes, not the flat on-disk layout.
        createReadAgentTraceTool(nd.getWorkdirBase, {
          actorId: params.id,
          tier,
          getNodes: () => fleetSessions.list(),
        }),
      ];
      const lifecycleAuthority = {
        actorId: params.id,
        tier,
        getNodes: () => fleetSessions.list(),
      };
      const fleetDeps = {
        permissionGate: nd.permissionGate,
        ...(nd.inheritMcpTools !== undefined
          ? { inheritMcpTools: nd.inheritMcpTools }
          : {}),
        ...(nd.shellTimeout !== undefined
          ? { shellTimeout: nd.shellTimeout }
          : {}),
        ...(nd.shellEnv !== undefined ? { shellEnv: nd.shellEnv } : {}),
        ...(nd.secretGuardExtraDeniedPaths !== undefined
          ? { secretGuardExtraDeniedPaths: nd.secretGuardExtraDeniedPaths }
          : {}),
        ...(nd.skillDirs !== undefined ? { skillDirs: nd.skillDirs } : {}),
        // Nested shared-cwd lanes reuse this worker's catalog, discovered
        // (or inherited) for exactly this cwd.
        skillSnapshot,
        ...(nd.extraToolPlugins !== undefined
          ? { extraToolPlugins: nd.extraToolPlugins }
          : {}),
        cwd: params.cwd,
        getWorkdirBase: nd.getWorkdirBase,
        provider: nd.provider,
        getBlobReader: () => sessionBlobReader,
        run: runSubAgent,
        telemetry: liveTelemetry,
        sessions: fleetSessions,
        fleetRecords,
        allowOrchestrator: false,
        ...(params.id !== undefined ? { parentSessionId: params.id } : {}),
        ...(nd.useWorktree !== undefined
          ? { useWorktree: nd.useWorktree }
          : {}),
        ...(nd.spawnAllowlist !== undefined
          ? { spawnAllowlist: nd.spawnAllowlist }
          : {}),
        ...(nd.onEvent !== undefined ? { onEvent: nd.onEvent } : {}),
        ...(nd.onProgress !== undefined ? { onProgress: nd.onProgress } : {}),
        ...(nd.settings !== undefined ? { settings: nd.settings } : {}),
        ...(nd.catalog !== undefined ? { catalog: nd.catalog } : {}),
        ...(nd.profiles !== undefined ? { profiles: nd.profiles } : {}),
        ...(nd.admission !== undefined ? { admission: nd.admission } : {}),
      };
      tools = [
        ...tools,
        createSpawnAgentTool(fleetDeps),
        createListAgentsTool({ sessions: fleetSessions, fleetRecords }),
        createCloseAgentTool({
          sessions: fleetSessions,
          fleetRecords,
          authority: lifecycleAuthority,
        }),
        createResumeAgentTool({
          sessions: fleetSessions,
          fleetRecords,
          authority: lifecycleAuthority,
        }),
        createInterruptAgentTool({
          sessions: fleetSessions,
          fleetRecords,
          authority: lifecycleAuthority,
        }),
        createSendInputTool({
          sessions: fleetSessions,
          fleetRecords,
          authority: lifecycleAuthority,
        }),
      ];
    }

    // Mount echo: dispatch verified requires_tools pre-spawn, but the filter
    // or mount may have shifted — a stamped tool missing here is a stale
    // snapshot, a non-continuable setup_error. Runs after all mounts, so a
    // dispatch that passed preflight never throws here.
    if (params.requiresTools !== undefined && params.requiresTools.length > 0) {
      const mountedNames = tools.map((tool) => tool.definition.name);
      const mountedCheck = checkMountedRequiresTools(
        params.requiresTools,
        mountedNames,
      );
      if (!mountedCheck.ok) {
        throw new Error(
          formatCapabilityUnavailable(
            {
              code: "stale_snapshot",
              tool: mountedCheck.missing[0] ?? "unknown",
              tools: mountedCheck.missing,
            },
            params.directorId ?? params.description,
          ),
        );
      }
    }

    const workerPrefix = advertisedToolNamesForWorker({
      orchestrator: params.orchestrator === true,
      ...(params.capabilities?.mode === "allow"
        ? { allow: params.capabilities.tools }
        : {}),
    });
    const advertisedSet = createAdvertisedToolset({
      sessionMode: "orchestrator",
      toolAvailability: {
        languageServerAvailable: false,
        operatorAvailable: false,
      },
      getProvider: () => ({
        providerName: params.provider.providerName,
        model: params.provider.model,
      }),
      builtInPrefix: workerPrefix,
      ...(params.requiresTools !== undefined && params.requiresTools.length > 0
        ? { pinnedTools: params.requiresTools }
        : {}),
    });
    const runnerHolder: {
      current?: ReturnType<typeof createDynamicToolRunner>;
    } = {};
    let workerDirector: SubAgentDirector | undefined;
    const allMountedDefs = (): ToolDefinition[] =>
      runnerHolder.current?.currentDefinitions() ??
      tools.map((tool) => tool.definition);
    const refreshAdvertised = (): void => {
      advertisedSet.flushPromotions();
      workerDirector?.updateToolDefinitions(
        advertisedSet.computeAdvertised(allMountedDefs()),
      );
    };
    const toolIndex = createToolIndex(allMountedDefs, [
      ...workerPrefix,
      ...(params.requiresTools ?? []),
    ]);
    tools = [
      ...tools,
      createToolSearchTool({
        search: (query, limit) => toolIndex.search(query, limit),
        lookup: (name) => allMountedDefs().find((def) => def.name === name),
        promote: (names) => {
          advertisedSet.activated.activate(names);
          refreshAdvertised();
        },
      }),
    ];

    tools = wrapAgentToolsWithResultTruncation(tools, {
      getBlobWriter: () => childBlobWriter,
      getContextDir: () => childContextDir,
    });

    // Same-cwd spawns within the TTL share the git/top-level snapshot
    // instead of re-running git per lane.
    const environment = await gatherEnvironmentCached(params.cwd);
    const attachedSection =
      params.attachedSkills !== undefined && params.attachedSkills.length > 0
        ? await formatAttachedSkillConstraints({
            names: params.attachedSkills,
            cwd: params.cwd,
            skillDirs,
          })
        : undefined;
    const roleBody = modelFamilyPolicy.leafRoleBody ?? params.systemPromptRole;
    const extensions = [
      ...(roleBody !== undefined ? [roleBody] : []),
      ...(attachedSection !== undefined ? [attachedSection] : []),
    ];
    const toolProfile = toolProfileForModel(params.provider);
    const advertisedDefs = advertisedSet.computeAdvertised(
      tools.map((t) => t.definition),
    );
    // The prompt lists what the wire carries: on gpt the file tools fold into
    // apply_patch, which is already mounted, so names can repeat.
    const toolNames = [
      ...new Set(
        foldFileToolNames(
          advertisedDefs.map((d) => d.name),
          toolProfile,
        ).map((name) => advertisedToolName(name, toolProfile)),
      ),
    ];
    const systemPrompt = buildSubAgentSystemPrompt(
      extensions.length > 0 ? extensions : undefined,
      environment,
      undefined,
      {
        orchestrator: params.orchestrator === true,
        toolNames,
        grokAntiThrash: shouldApplyGrokAntiThrash({
          providerName: params.provider.providerName,
          model: params.provider.model,
          orchestrator: params.orchestrator === true,
        }),
        promptResidual: modelFamilyPolicy.promptResidual,
      },
    );

    // Assigned once the leaf's trace dir exists; the director factory closes
    // over this binding and only fires after that point.
    let interventions: InterventionSink = NOOP_INTERVENTION_SINK;
    // Set by the director on force-stop via capabilities.reply (the normal
    // send success path) — carried into the result, not re-derived from text.
    let directorForcedStopReason: ForcedStopReason | undefined;
    let agentHandle: Awaited<
      ReturnType<typeof createAgentWithLiveToolDispatch>
    > | null = null;
    const requestContinuation = (): void => {
      compactContinue.request(askDirectorState, deliverCompactContinue);
    };
    deliverCompactContinue = (): void => {
      try {
        agentHandle?.deliver(buildCompactionContinuationMessage());
      } catch {
        // Agent may be closing; a dropped continuation is harmless.
      }
    };

    // modelFamilyPolicy is resolved above at the skill mount; reused here
    // for stall timing and wire-schema normalization.

    // Family-gate wire schemas like main sessions: worker advertise uses a
    // smaller prefix plus tool_search; computeAdvertised normalizes family.
    const directorDef = defineDirector({
      id: `${ID_PREFIX}/subagent`,
      configSchema: type({}),
      factory: (_config, _env, agentCtx) => {
        const director = new SubAgentDirector(
          agentCtx.systemPrompt,
          advertisedSet.computeAdvertised(
            projectToolDefinitions(
              foldFileToolDefinitions(agentCtx.toolDefinitions, toolProfile),
              toolProfile,
            ),
          ),
          requestContinuation,
          modelFamilyPolicy.subAgentStallTimeoutMs,
          Date.now,
          shouldRequireEvidence(params),
          shouldRequirePlanSubstance(params),
          params.retryPolicy ??
            createCorbitsRetryPolicy({
              providerId: params.provider.providerName,
              admission: params.admission ?? getProcessAdmissionQueue(),
            }),
          modelFamilyPolicy.toolDisciplineRules,
        );
        director.observeForcedStop((reason) => {
          directorForcedStopReason = reason;
        });
        workerDirector = director;
        director.observeAskPending(() => askDirectorState.pending);
        director.observeInterventions((event) => {
          interventions(event);
        });
        // Continuation infers after tool results land, long after the
        // attempt-start refresh: the wrapper re-freshes the OAuth credential
        // before the reactor executes the infer; decide() stays pure.
        return withContinuationOAuthRefresh(director, {
          getAgent: () => agent,
          sources: bundle.sources,
          defaultSource: bundle.defaultSource,
          catalog: params.catalog,
        });
      },
    });

    // Directors are pure decide() functions with no timer (see
    // checkStallPing), so a silent leaf needs an external nudge: ping the
    // compaction continuation channel at the stall interval; the director
    // acts only if nothing happened since. Skip while ask_director is
    // parked — a deferred ping would make the post-unpark flush look like
    // an empty stall window.
    stallWatchdog = setInterval(() => {
      if (askDirectorState.pending) return;
      deliverCompactContinue();
    }, modelFamilyPolicy.subAgentStallTimeoutMs);
    if (typeof stallWatchdog.unref === "function") stallWatchdog.unref();

    // Concurrent workers resolve relative permission subjects against this
    // identity's cwd (see identity-context.ts).
    const subAgentIdentity = {
      description: params.description,
      cwd: params.cwd,
    };
    const withWorkerIdentity = <T>(fn: () => T): T =>
      runWithSubAgentIdentity(subAgentIdentity, fn);
    const toolsFactory = defineTool({
      id: `${ID_PREFIX}/subagent-tools`,
      definitions: [],
      // Without the watchdog config, child tool calls run under default budgets
      // and ignore tools.timeoutMs / maxTimeoutMs / waitForApproval settings.
      factory: () => {
        const runner = createDynamicToolRunner(
          tools,
          toolWatchdogFromSettings(params.settings),
        );
        runnerHolder.current = runner;
        runner.setCallGate(advertisedSet.isAdvertised, {
          isActivated: (name) => advertisedSet.activated.has(name),
        });
        runner.setOnUndeclaredCall((name) => {
          advertisedSet.activated.activate([name]);
          refreshAdvertised();
        });
        return withAuthzParityDefinitions({
          ...runner,
          run: (call, signal) =>
            withWorkerIdentity(() => runner.run(call, signal)),
        });
      },
    });

    // Reuse the caller's session-store id as the on-disk directory name
    // when it is safe as a path segment, so read_agent_trace walks the
    // same parentSessionId chain SubAgentSessionStore already tracks — no
    // second, disk-only identity scheme.
    const safeRequestedId =
      params.id !== undefined && /^[A-Za-z0-9_-]+$/.test(params.id)
        ? params.id
        : undefined;
    const sessionId = safeRequestedId ?? generateSessionId();
    // Fleet-less runs mint their own id — keep the grant sidecar keyed to
    // the same session the parent would observe.
    if (workerGrantSessionId === undefined) workerGrantSessionId = sessionId;
    const workdir = join(params.workdirBase, "subagents", sessionId);
    await mkdir(workdir, { recursive: true });
    childContextDir = workdir;
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
        sources: [
          {
            provider: params.provider.providerName,
            model: params.provider.model,
          },
        ],
      },
    });

    const { storage, audit } = await createSessionStores(workdir);
    childBlobWriter = (key, bytes, contentType) =>
      storage.writeBlob(key, bytes, contentType);
    const authorize = createWorkerAuthorize(params.permissionGate, {
      sessionId: () => workerGrantSessionId,
    });

    const head = {
      provider: params.provider.providerName,
      model: params.provider.model,
    };
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
        : buildSubAgentPrimarySource(
            params.provider,
            params.catalog,
            params.settings,
          );
    const workerSource =
      bundle.sources.find((source) => source.id === bundle.defaultSource) ??
      bundle.sources[0];
    if (workerSource === undefined)
      throw new Error("sub-agent source bundle is empty");
    agent = await createAgentWithLiveToolDispatch(def, {
      sources: bundle.sources,
      defaultSource: bundle.defaultSource,
      storage,
      workdir,
      // Secrets resolve out of the first-party credential cell (see
      // ../config/source-credentials.ts): sources name a credentialId and
      // the vendored harness reads the secret through this resolver.
      readCurrentMaterial: readSourceCredentialMaterial,
      // contextTransforms ride deps: @intx/agent forwards deps into reactor
      // assembly verbatim; the vendored assembly picks them up from there.
      deps: {
        ...inferenceDeps,
        contextTransforms: [
          createAttachmentRehydrateTransform((key) => storage.readBlob(key)),
        ],
      },
      audit,
      sessionId,
      authorize: (resource, action, context) =>
        withWorkerIdentity(() => authorize(resource, action, context)),
      directors: createDirectorRegistry({
        factories: [directorDef.factory],
        defaultId: `${ID_PREFIX}/subagent`,
      }),
      compactors: {
        "pruning-compactor": createSessionPruningCompactor({
          readPriorHandoff: () =>
            tryReadPriorHandoffFile((key) => storage.readBlob(key)),
        }),
      },
    });
    // Tools were built before the agent; bind the child's store now so own spills
    // resolve without dropping the parent fallback.
    childBlobReader = agent.blobReader;
    agentHandle = agent;
    backgroundExitSink = (exit) => {
      try {
        agentHandle?.deliver(buildShellBackgroundMessage(exit));
      } catch {
        // Agent may be closing; a dropped completion is harmless.
      }
    };

    // Collect tool activity for the parent report; forward progress without
    // dumping the event stream into the transcript (avoids interleaving).
    const toolNamesUsed: string[] = [];
    let lastPartialText = "";
    // Cap accumulated prose so cancel/deadline salvage keeps substantive
    // mid-run text, not only the final cycle.
    const TURN_PROSE_CAP = 12_000;
    let accumulatedProse = "";
    let terminalProviderError: InferenceErrorLike | undefined;
    // Thrash paths from tool.start so mid-tool cancel still lists files touched.
    let thrashState = EMPTY_THRASH_STATE;
    const withTelemetry = (result: RunSubAgentResult): RunSubAgentResult => ({
      ...result,
      telemetry: { ...telemetryRollup },
    });
    // Watch the in-flight cycle's streamed text so a cancel/deadline salvage
    // has the cycle tail before a turn boundary carries it.
    const cycleRecorder = createCycleTextRecorder(() => workdir);
    const runSettlement = createRunEventSettlement();
    const streamSink = (rawEvent: ReactorEmittedEvent): void => {
      runSettlement.handleEvent(rawEvent);
      const event = sanitizeDiagnosticValue(rawEvent, [
        readSourceCredentialMaterial(workerSource.credentialId).secret,
      ]) as ReactorEmittedEvent;
      const name = subAgentToolName(event);
      if (name !== null) {
        toolNamesUsed.push(name);
        telemetryRollup.tool_call_count += 1;
        params.onProgress?.({
          description: params.description,
          toolName: name,
        });
      }
      if (event.type === "tool.start") {
        const call = (
          event as { data?: { call?: { name?: unknown; arguments?: unknown } } }
        ).data?.call;
        if (typeof call?.name === "string" && call.name.length > 0) {
          thrashState = nextThrashState(thrashState, [
            { type: "tool_call", name: call.name, arguments: call.arguments },
          ]);
        }
      }
      if (event.type === "tool.done") {
        const result = (event as { data?: { result?: { isError?: unknown } } })
          .data?.result;
        if (result?.isError === true) telemetryRollup.tool_error_count += 1;
      }
      if (event.type === "inference.start") {
        settlementState.latestModel = event.data.model;
        terminalProviderError = undefined;
      }
      if (event.type === "inference.done") {
        settlementState.latestModel = event.data.source.model;
        terminalProviderError = undefined;
      }
      if (event.type === "inference.error") {
        const error = event.data.error;
        terminalProviderError = {
          category: error.category,
          ...(error.message !== undefined ? { message: error.message } : {}),
          ...(error.statusCode !== undefined
            ? { statusCode: error.statusCode }
            : {}),
          ...(error.retryAfterMs !== undefined
            ? { retryAfterMs: error.retryAfterMs }
            : {}),
          ...("raw" in error && error.raw !== undefined
            ? { raw: error.raw }
            : {}),
          providerId: params.provider.providerName,
        };
      }
      if (onTurnBoundary(event)) {
        telemetryRollup.turn_count += 1;
        const usage = (
          event as {
            data?: {
              usage?: {
                input?: unknown;
                output?: unknown;
                cacheRead?: unknown;
                cacheWrite?: unknown;
                thinking?: unknown;
              };
            };
          }
        ).data?.usage;
        if (usage !== undefined) {
          if (typeof usage.input === "number")
            telemetryRollup.input_tokens += usage.input;
          if (typeof usage.output === "number")
            telemetryRollup.output_tokens += usage.output;
          if (typeof usage.cacheRead === "number") {
            telemetryRollup.cache_read_tokens += usage.cacheRead;
          }
          if (typeof usage.cacheWrite === "number") {
            telemetryRollup.cache_write_tokens += usage.cacheWrite;
          }
          if (typeof usage.thinking === "number") {
            telemetryRollup.reasoning_tokens += usage.thinking;
          }
        }
      }
      cycleRecorder.handleEvent(event);
      const partial = partialTextFromEvent(event);
      if (partial !== null) {
        lastPartialText = partial;
        const trimmed = partial.trim();
        if (trimmed.length > 0) {
          const joined =
            accumulatedProse.length === 0
              ? trimmed
              : `${accumulatedProse}\n\n${trimmed}`;
          accumulatedProse =
            joined.length <= TURN_PROSE_CAP
              ? joined
              : joined.slice(-TURN_PROSE_CAP);
        }
      }
      params.onEvent?.(event);
    };

    streamPromise = consumeStream(agent.stream(), streamSink).finally(
      runSettlement.endStream,
    );

    const sendAndSettle = async (
      message: string,
      options: { signal: AbortSignal },
    ): ReturnType<NonNullable<typeof agent>["send"]> => {
      const pending = runSettlement.beginSend();
      try {
        if (agent === null) throw new Error("sub-agent is not running");
        const result = await agent.send(message, options);
        await pending.settled;
        return result;
      } catch (error) {
        pending.cancel();
        throw error;
      }
    };

    const sendWithProviderFailure = async (
      message: string,
      options: { signal: AbortSignal },
    ): ReturnType<NonNullable<typeof agent>["send"]> => {
      try {
        return await sendAndSettle(message, options);
      } catch (cause) {
        if (terminalProviderError !== undefined) {
          throw createResolvedProviderFailureError(
            params.provider.providerName,
            terminalProviderError,
          );
        }
        throw cause;
      }
    };

    // Aborting the send signal only rejects the promise; the child reactor keeps
    // running until close() (same hard-stop rule as the parent in runner.ts).
    closeOnAbort = (): void => {
      // interrupt_agent is the keep-alive path: it never reaches here, so its
      // background children stay.
      backgroundShells.disposeAll("parent abort");
      void (async () => {
        try {
          await agent?.close();
        } catch {
          // close is idempotent; ignore races with disposeSubAgentSession.
        }
      })();
    };
    if (runController.signal.aborted) {
      closeOnAbort();
    } else {
      runController.signal.addEventListener("abort", closeOnAbort, {
        once: true,
      });
    }

    // Bounded, idempotent close handle (close_agent). Abort stops a
    // still-running turn; a finished turn is a no-op. posix dispose/reap
    // runs before agent.close so a wedged close cannot skip killing
    // detached run_shell children; the deadline abandons a hung close
    // rather than report success while children stay live.
    if (params.onAgentReady !== undefined) {
      const boundedClose = async (
        deadlineMs = DEFAULT_CLOSE_DEADLINE_MS,
      ): Promise<void> => {
        if (!runController.signal.aborted)
          runController.abort(new Error("closed by close_agent"));
        backgroundShells.disposeAll("closed by close_agent");
        try {
          await awaitBoundedTeardown(
            disposeSubAgentSession({
              signal: runController.signal,
              ...(closeOnAbort !== undefined ? { closeOnAbort } : {}),
              agent,
              ...(streamPromise !== undefined ? { streamPromise } : {}),
              posixTools,
            }),
            deadlineMs,
          );
        } finally {
          // The finally block kept the parent-abort forwarding listener
          // alive for a persisted session (see runController.dispose's doc);
          // tear it down now that the session is actually closing.
          runController.dispose();
        }
      };
      // Interrupt fires interruptController only — never runController or
      // close — so a wedged agent.close cannot hang teardown; session lives.
      const interrupt = (): void => {
        if (!interruptController.signal.aborted) {
          interruptController.abort(
            new Error("interrupted by interrupt_agent"),
          );
        }
      };
      // resume_agent's payoff — call agent.send() again on the same live
      // agent object, reusing full context rather than starting fresh.
      const followup = async (message: string): Promise<string> => {
        resetAskDirectorTurn(askDirectorState);
        interruptController = new AbortController();
        // A steer supersedes the dispatched turn: mint a fresh submit_result
        // token (the handler closure reads this binding, so the old token
        // is rejected from here on) and hand the worker the replacement.
        let steered = message;
        if (turnToken !== undefined) {
          turnToken = generateSessionId();
          resetSubmitResultTurn(submitResultState);
          steered = `${message}\n\n${formatTurnTokenNotice(turnToken)}`;
        }
        const result = await sendWithProviderFailure(steered, {
          signal: sendAbortSignal(),
        });
        if (terminalProviderError !== undefined) {
          throw createResolvedProviderFailureError(
            params.provider.providerName,
            terminalProviderError,
          );
        }
        if (result.type !== "reply") assertReplySend(result);
        return result.reply.trim().length > 0
          ? result.reply.trim()
          : "Sub-agent finished without a textual result.";
      };
      const deliver = (message: string): void => {
        if (agent === null) throw new Error("sub-agent is not running");
        agent.deliver({
          ref: { uid: 1, mailbox: "INBOX" },
          headers: {
            from: "parent@local",
            to: ["agent@local"],
            date: new Date().toISOString(),
            messageId: `<send-input-${crypto.randomUUID()}@local>`,
            interchangeType: "conversation.message",
          },
          flags: [],
          content: message,
          signatureStatus: "missing",
        });
      };
      params.onAgentReady({
        close: boundedClose,
        interrupt,
        followup,
        deliver,
      });
    }

    const fullPrompt = buildDispatchBrief({
      description: params.description,
      prompt: params.prompt,
      ...(params.context !== undefined ? { context: params.context } : {}),
      ...(params.goals !== undefined && params.goals.length > 0
        ? { goals: params.goals }
        : {}),
      ...(params.intent !== undefined ? { intent: params.intent } : {}),
      ...(params.successCriteria !== undefined &&
      params.successCriteria.length > 0
        ? { successCriteria: params.successCriteria }
        : {}),
      ...(params.doNot !== undefined && params.doNot.length > 0
        ? { doNot: params.doNot }
        : {}),
      ...(params.reportFocus !== undefined &&
      params.reportFocus.trim().length > 0
        ? { reportFocus: params.reportFocus }
        : {}),
      ...(turnToken !== undefined ? { turnToken } : {}),
    });
    const ensureNotAborted = (): void => {
      // Re-read .aborted after await — control-flow narrowing would wrongly
      // treat a pre-send check as permanent.
      if (runController.signal.aborted) throw abortError(runController.signal);
    };
    const thisTurnInterrupt = interruptController;
    const parentFacing = (body: string, reason?: ForcedStopReason): string =>
      appendActivitySummary(
        appendSubAgentParentHints(body, reason),
        toolNamesUsed,
      );
    try {
      ensureNotAborted();
      // Either the run controller or the interrupt signal stops this send(),
      // but only runController's abort is wired to closeOnAbort/teardown.
      const sendOpts = { signal: sendAbortSignal() };
      const outerStartedAt = Date.now();
      let attempt = 0;
      let result: Awaited<ReturnType<typeof sendWithProviderFailure>>;
      for (;;) {
        attempt += 1;
        const fresh = await refreshInferenceSourceBundle(
          bundle.sources,
          bundle.defaultSource,
          params.catalog,
        );
        agent.setSources(fresh.sources, fresh.defaultSource);
        try {
          result = await sendWithProviderFailure(fullPrompt, sendOpts);
          if (terminalProviderError !== undefined) {
            throw createResolvedProviderFailureError(
              params.provider.providerName,
              terminalProviderError,
            );
          }
        } catch (sendError) {
          const resolved = isResolvedProviderFailureError(sendError)
            ? sendError
            : undefined;
          const toolsUsed =
            toolNamesUsed.length > 0 || telemetryRollup.tool_call_count > 0;
          if (
            resolved === undefined ||
            resolved.category !== "retryable" ||
            toolsUsed ||
            attempt >= MAX_OUTER_ATTEMPTS
          ) {
            throw sendError;
          }
          const elapsedMs = Date.now() - outerStartedAt;
          const outerRemainingMs = MAX_BLIND_WAIT_MS - elapsedMs;
          if (outerRemainingMs <= 0) throw sendError;
          if (runController.signal.aborted || runController.deadlineHit())
            ensureNotAborted();
          if (thisTurnInterrupt.signal.aborted)
            throw abortError(thisTurnInterrupt.signal);
          const retryAfterMs =
            terminalProviderError?.statusCode === 429
              ? terminalProviderError.retryAfterMs
              : undefined;
          const backoffMs =
            retryAfterMs !== undefined
              ? Math.min(retryAfterMs, MAX_BLIND_WAIT_MS)
              : Math.round(
                  outerRetryDelayMs(params) * (0.8 + Math.random() * 0.4),
                );
          const delayMs = Math.min(backoffMs, outerRemainingMs);
          params.onProgress?.({
            description:
              `${params.description} (provider retry ` +
              `${attempt + 1}/${MAX_OUTER_ATTEMPTS} in ${delayMs}ms)`,
            toolName: "retry",
          });
          await sleepUnlessAborted(delayMs, [
            runController.signal,
            thisTurnInterrupt.signal,
          ]);
          if (runController.signal.aborted || runController.deadlineHit())
            ensureNotAborted();
          if (thisTurnInterrupt.signal.aborted)
            throw abortError(thisTurnInterrupt.signal);
          continue;
        }
        break;
      }
      if (result.type !== "reply") assertReplySend(result);
      // A successful non-empty reply must not be clobbered by a late cancel
      // racing the completion window. Empty replies still honor abort so a
      // cancelled run salvages or rethrows instead of faking a result.
      if (preferCompletedSubAgentReply(result.reply) === "honor-abort") {
        ensureNotAborted();
      }
      const reply =
        result.reply.trim().length > 0
          ? result.reply.trim()
          : "Sub-agent finished without a textual result.";
      // Normalize into the structured envelope so the parent always gets a
      // consistent shape even when the model returns free-form prose.
      const report = formatSubAgentReport(parseSubAgentReport(reply));
      // Only a clean completion retains: an aborted or salvaged run falls
      // through without setting this, so the finally still tears down.
      turnSucceeded = true;
      return withTelemetry({
        report: parentFacing(report, directorForcedStopReason),
        ...(directorForcedStopReason !== undefined
          ? { stopReason: directorForcedStopReason }
          : {}),
        // Only this path skips teardown under persist — tell the caller so
        // a salvage below is never mistaken for a live, resumable agent.
        ...(params.persist === true ? { agentRetained: true } : {}),
      });
    } catch (err) {
      // interrupt_agent fired its own signal, not runController's — check
      // first so it skips the cancel/deadline salvage and bare AbortError.
      if (thisTurnInterrupt.signal.aborted && !runController.signal.aborted) {
        interruptedKeepAlive = true;
        // No stream drain: the session stays alive for followup, and a live
        // shell descendant would park this settlement forever. The recorder
        // snapshotted the buffer at entry; late events are unsalvaged.
        const abortedCycleText = await cycleRecorder.dispose("cancelled");
        const tail = salvageFindingsText(
          accumulatedProse,
          lastPartialText,
          abortedCycleText,
        );
        return withTelemetry({
          report: parentFacing(
            forcedStopReport("interrupted", tail, {
              detail: "interrupted by interrupt_agent",
              paths: salvagePathsFromThrash(thrashState),
            }),
            "interrupted",
          ),
          stopReason: "interrupted",
          interrupted: true,
        });
      }
      if (isSubAgentCancelError(err, runController.signal)) {
        // Close the recorder before the dead cycle's inference.error so its
        // auto-flush cannot mislabel this salvage. Drain first so
        // lastPartialText catches late tool events before bare-vs-salvage is
        // decided. A parent cancel stays labelled cancelled even if the
        // outcome below rethrows; the bounded drain reaps a wedged stream.
        const abortedCycleText = await cycleRecorder.dispose(
          runController.deadlineHit() ? "deadline" : "cancelled",
          { drain: drainStreamWithReapDeadline(streamPromise) },
        );
        // Deadline always salvages (even with zero output); cancel salvages
        // after any progress. Pre-progress cancel surfaces as AbortError.
        const hadProgress =
          toolNamesUsed.length > 0 ||
          lastPartialText.trim().length > 0 ||
          accumulatedProse.trim().length > 0;
        const outcome = resolveSubAgentCatchOutcome({
          deadlineHit: runController.deadlineHit(),
          hadProgress,
        });
        if (outcome !== "rethrow") {
          const reason =
            outcome === "salvage-deadline" ? "deadline" : "cancelled";
          const tail = salvageFindingsText(
            accumulatedProse,
            lastPartialText,
            abortedCycleText,
          );
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
          return withTelemetry({
            report: parentFacing(
              forcedStopReport(reason, tail, {
                ...(detail !== undefined ? { detail } : {}),
                paths: salvagePathsFromThrash(thrashState),
              }),
              reason,
            ),
            stopReason: reason,
          });
        }
      }
      throw err;
    }
  } finally {
    if (stallWatchdog !== undefined) clearInterval(stallWatchdog);
    // A run keeps its agent alive on clean completion under persist, or
    // when interrupt_agent fired and the session must stay reusable. Both
    // skip teardown and keep the parent-signal listener for a later cancel.
    const persisting =
      (params.persist === true && turnSucceeded) || interruptedKeepAlive;
    // A persisting run keeps the parent-signal forwarding alive (see
    // createSubAgentRunController's dispose doc); boundedClose disposes the
    // runController fully once the session actually tears down.
    runController.dispose({ keepParentListener: persisting });
    // A persisted, cleanly-completed session skips teardown — it stays open
    // until close_agent (or a later failed/aborted run) tears it down.
    if (!persisting || !backgroundShellsMounted) {
      backgroundShells.disposeAll("sub-agent closed");
    }
    if (!persisting) {
      // Bounded like close_agent: teardown wedged by a live shell descendant
      // fails the run instead of parking it forever. Tests inject a short
      // deadline; production keeps the 30s default.
      await awaitBoundedTeardown(
        disposeSubAgentSession({
          signal: runController.signal,
          ...(closeOnAbort !== undefined ? { closeOnAbort } : {}),
          agent,
          ...(streamPromise !== undefined ? { streamPromise } : {}),
          posixTools,
        }),
        params.teardownDeadlineMs ?? DEFAULT_CLOSE_DEADLINE_MS,
      );
    }
  }
}
