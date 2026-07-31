import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  createAgent,
  defineAgent,
  defineTool,
  createToolRunner,
  createDirectorRegistry,
  defineDirector,
  fromToolRunner,
  stringTool,
  tool,
} from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import { noopAuditStore, permissiveAuthorize } from "@intx/agent/testing";
import { createOptimizedContextStore } from "../session/optimized-context-store.js";
import { type } from "arktype";
import { createPosixTools, type ToolPlugin } from "@intx/tools-posix";
import { createDynamicToolRunner } from "../tui/dynamic-tool-runner.js";
import { DefaultDirector, type ExtendedInferenceOptions } from "@intx/inference";
import type {
  ReactorInboundEvent,
  ReactorState,
  ReactorCapabilities,
  ReactorAction,
  ToolDefinition,
  ToolResult,
  ConversationTurn,
  InferenceOptions,
} from "@intx/types/runtime";

import { seedPricingMetadataFromCache } from "../cost/pricing-metadata.js";
import { defaultPricingCachePath } from "../cost/pricing-fetcher.js";
import { buildBifrostSource, buildOpenAISource, runtimeSettingsWithCatalog, type ProviderCatalogEntry } from "../config/index.js";
import { buildInferenceSourceForRef, buildSubagentSources } from "../config/inference-sources.js";
import { createInferenceDependencies } from "../provider/inference-dependencies.js";
import type { ReasoningEffort } from "../provider/reasoning-effort.js";
import {
  advertiseShellGuardTimeout,
  type ShellTimeoutConfig,
} from "../plugins/shell-guard-plugin.js";
import { advertiseEditFileLineRange } from "../plugins/edit-file-line-range.js";
import { createWebFetchTool } from "../tools/web-fetch.js";
import { createWebSearchTool } from "../tools/web-search.js";
import { buildCorePosixToolPlugins } from "../agent/posix-tool-plugins.js";
import { createCompositeBlobReader } from "../agent/lazy-blob-reader.js";
import type { BlobReader } from "@intx/types/runtime";
import type { PermissionGate } from "../permission/gate.js";

import { buildSubAgentSystemPrompt } from "../agent/prompts.js";
import { shouldApplyGrokAntiThrash } from "./provider-family.js";
import { resolveModelFamilyPolicy } from "../agent/model-family-policy.js";

import { createCompactionGovernor, type CompactionGovernor } from "../agent/compaction.js";
import { createPruningCompactor } from "../session/compactor.js";
import { createAttachmentRehydrateTransform } from "../session/attachment-store.js";
import { createModelSummarizer } from "../session/summarizer.js";
import { gatherEnvironment } from "../agent/environment.js";
import { generateSessionId } from "../session/index.js";
import { consumeStream } from "../session/stream-consumer.js";
import { createCycleTextRecorder } from "../session/stream-journal.js";
import { withSubAgentSlot } from "./concurrency.js";
import { appendCycleText, detectRepetition, type RepetitionHit } from "./repetition.js";
import { formatSubAgentTaskAuthFailureMessage } from "./inference-auth-failure.js";
import { refreshInferenceSourceBundle } from "./refresh-inference-source.js";
import type { CapabilityFilter, AgentProfile } from "../agent/profiles.js";
import type { Settings, ProviderTier } from "../config/settings.js";
import {
  resolveDefaultSubAgentMaxTurns,
  resolveSubAgentMaxTurns,
  resolveTier,
  resolveInferenceWithPolicy,
  toolWatchdogFromSettings,
  validateTaskMaxTurns,
} from "../config/settings.js";
import { resolveToolExecutionTimeoutMs } from "../tui/tool-execution-watchdog.js";
import { validateEffort } from "../provider/reasoning-effort.js";
import { isCodexProviderName } from "../config/codex-providers.js";
import { createSearchAgentsTool } from "../agent/agent-search.js";
import { manageTasksDefinition, parseManageTasksArgs } from "../agent/tasks.js";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { SubAgentSessionStore } from "./session-store.js";
import { ID_PREFIX } from "../branding.js";
import {
  EMPTY_THRASH_STATE,
  evaluateThrashStop,
  nextThrashState,
  type ThrashConfig,
  type ThrashState,
} from "./thrash.js";

export type { SubAgentSession, SubAgentSessionStore, SubAgentTranscriptEntry } from "./session-store.js";
export { createSubAgentSessionStore } from "./session-store.js";
export {
  DEFAULT_THRASH_CONFIG,
  EMPTY_THRASH_STATE,
  evaluateThrashStop,
  nextThrashState,
  thrashForceReport,
  thrashFromReRead,
  type ThrashConfig,
  type ThrashState,
  type ThrashStopReason,
} from "./thrash.js";

export { DEFAULT_SUBAGENT_MAX_TURNS } from "../config/settings.js";

/** Consecutive identical tool-call fingerprints before a leaf is forced to stop. */
export const DEFAULT_SUBAGENT_REPEAT_LIMIT = 2;

// Minimum gap kept between an opt-in internal deadline and the outer
// tool-execution watchdog, so there is time left for the salvage report to
// unwind and return before the outer watchdog would discard the run wholesale.
export const SUBAGENT_DEADLINE_MARGIN_MS = 30_000;

/**
 * Clamp an explicit opt-in wall-clock deadline to stay a margin below the
 * effective outer tool-execution watchdog. There is no default leaf deadline —
 * maxTurns + operator cancel are the primary bounds; callers pass deadlineMs
 * only when they want an extra wall-clock stop.
 *
 * Returns undefined (do not arm) when the outer watchdog is at or below the
 * salvage margin — an internal deadline would otherwise race or exceed outer
 * and leave no room to return a salvage report.
 */
export function resolveSubAgentDeadlineMs(
  requestedMs: number,
  outerWatchdogMs: number,
): number | undefined {
  const requested = Math.max(1, Math.floor(requestedMs));
  if (outerWatchdogMs <= SUBAGENT_DEADLINE_MARGIN_MS) return undefined;
  // Ceiling must never exceed outer − margin (and stays ≥ 1 once outer > margin).
  const ceiling = Math.max(1, outerWatchdogMs - SUBAGENT_DEADLINE_MARGIN_MS);
  return Math.min(requested, ceiling);
}

/**
 * After agent.send resolves: keep a non-empty reply even if abort fired in the
 * completion window. Empty replies still honor abort so the catch path can
 * salvage from lastPartialText / tools rather than inventing a "no textual result"
 * success over a cancelled run.
 */
export function preferCompletedSubAgentReply(reply: string): "keep-reply" | "honor-abort" {
  return reply.trim().length > 0 ? "keep-reply" : "honor-abort";
}

export type SubAgentCatchOutcome =
  | "salvage-repetition"
  | "salvage-deadline"
  | "salvage-cancelled"
  | "rethrow";

/**
 * Decide what a cancelled/aborted sub-agent run should return to the parent.
 * An opt-in deadline firing must always produce a salvage report — even with
 * zero tool calls and zero partial text — so the parent gets a graceful report
 * instead of a bare AbortError racing the outer tool-execution watchdog. A
 * genuine pre-progress operator cancel still rethrows so the task tool's
 * cancel path stays a bare abort; mid-run cancel with progress salvages.
 */
export function resolveSubAgentCatchOutcome(input: {
  deadlineHit: boolean;
  hadProgress: boolean;
  repetitionHit?: boolean;
}): SubAgentCatchOutcome {
  // Repetition wins: it is our own abort, so it can never also be a deadline
  // (the deadline timer refuses to mark an already-aborted run), and it always
  // salvages — the looped tail is exactly what the parent needs to see.
  if (input.repetitionHit === true) return "salvage-repetition";
  if (input.deadlineHit) return "salvage-deadline";
  if (input.hadProgress) return "salvage-cancelled";
  return "rethrow";
}

export function subAgentTurnLimitExceeded(turnsCompleted: number, maxTurns: number): boolean {
  return turnsCompleted >= maxTurns;
}

export function subAgentNoProgress(
  consecutiveIdentical: number,
  repeatLimit: number,
): boolean {
  return consecutiveIdentical >= repeatLimit;
}

// Stable JSON so key insertion order does not create false progress between turns.
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
}

/** Fingerprint of a turn's tool calls, or null when the turn has none. */
export function fingerprintToolCalls(
  content: ReadonlyArray<{ type: string; name?: string; arguments?: unknown }>,
): string | null {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type !== "tool_call") continue;
    const name = typeof block.name === "string" ? block.name : "";
    let args: unknown = block.arguments ?? {};
    // Some adapters hand arguments as a JSON string; normalize so fingerprints match.
    if (typeof args === "string") {
      try {
        args = JSON.parse(args) as unknown;
      } catch {
        // Keep the raw string when it is not valid JSON.
      }
    }
    parts.push(`${name}:${stableJson(args)}`);
  }
  if (parts.length === 0) return null;
  parts.sort();
  return parts.join("|");
}

export type SubAgentStopReason =
  | "complete"
  | "turn-budget"
  | "no-progress"
  | "never-acted"
  | "thrash"
  | "report-forced";

/**
 * Pure stop decision for leaf workers. Null means keep running tools.
 *
 * Precedence when tools are still firing:
 * no-progress (identical fingerprints) > thrash (re-read pressure) >
 * turn-budget (hard cap). "report-forced" is not a competing stop reason —
 * it is a one-shot signal, forceReportWithin turns before the cap, telling
 * the caller to inject a wrap-up nudge and keep running; turn-budget remains
 * reachable afterward. Tool-less turns always end the leaf as complete or
 * never-acted.
 */
export function evaluateSubAgentStop(input: {
  hasToolCalls: boolean;
  /** True when any turn in this run (including the current one) issued tools. */
  everHadToolCalls: boolean;
  turnsCompleted: number;
  maxTurns: number;
  consecutiveIdentical: number;
  repeatLimit: number;
  /** When set, progressive thrash / force-report are evaluated after no-progress. */
  thrashState?: ThrashState;
  thrashConfig?: Partial<ThrashConfig>;
}): SubAgentStopReason | null {
  // A tool-less turn always ends the leaf; classify success vs never-acted by
  // whether the run used tools at all (planning-only prose is not a successful implement).
  if (!input.hasToolCalls) {
    return input.everHadToolCalls ? "complete" : "never-acted";
  }
  // No-progress is more specific than thrash or the turn budget when both could apply.
  if (subAgentNoProgress(input.consecutiveIdentical, input.repeatLimit)) return "no-progress";
  if (input.thrashState !== undefined) {
    const thrashStop = evaluateThrashStop({
      state: input.thrashState,
      hasToolCalls: true,
      turnsCompleted: input.turnsCompleted,
      maxTurns: input.maxTurns,
      ...(input.thrashConfig !== undefined ? { config: input.thrashConfig } : {}),
    });
    if (thrashStop !== null) return thrashStop;
  }

  if (subAgentTurnLimitExceeded(input.turnsCompleted, input.maxTurns)) return "turn-budget";
  return null;
}


export type ToolCallStreak = {
  lastFingerprint: string | undefined;
  consecutiveIdentical: number;
};

/** Advance consecutive-identical bookkeeping for one inference.done turn. */
export function nextToolCallStreak(
  prev: ToolCallStreak,
  fingerprint: string | null,
): ToolCallStreak {
  if (fingerprint === null) {
    return { lastFingerprint: undefined, consecutiveIdentical: 0 };
  }
  if (fingerprint === prev.lastFingerprint) {
    return {
      lastFingerprint: fingerprint,
      consecutiveIdentical: prev.consecutiveIdentical + 1,
    };
  }
  return { lastFingerprint: fingerprint, consecutiveIdentical: 1 };
}

// A sub-agent is a worker, not a chat partner: it runs until it stops calling
// tools, at which point its final assistant text is the result handed back to
// the dispatcher — unless it never called tools at all, in which case the
// result is a never-acted salvage report rather than a successful implement.
// It has no submit_output or ask_operator; consequential tools still go through
// the parent's permission gate (grants, auto mode, or prompts). Hard stops also
// fire on identical tool fingerprints (no-progress), progressive re-read thrash,
// and the hard turn budget so a thrashing leaf cannot burn the full budget
// with no parent-visible report. Near the budget the leaf gets a one-shot
// wrap-up nudge (report-forced) rather than a stop, so turn-budget stays
// reachable for a leaf that is genuinely still making progress.

function lastText(content: ReadonlyArray<{ type: string }>): string {
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as { type: string; text?: string };
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return "";
}

/** Best-effort partial assistant text from a stream event (inference.done). */
export function partialTextFromEvent(event: ReactorEmittedEvent): string | null {
  if (event.type !== "inference.done") return null;
  // Stream events nest the turn under data (same shape as hooks/renderer).
  // Guard data.turn so a malformed event cannot throw in the stream sink.
  const turn = event.data?.turn;
  if (turn === undefined || !Array.isArray(turn.content)) return null;
  const text = lastText(turn.content);
  return text.length > 0 ? text : null;
}

/**
 * Build the parent-facing report when a leaf is force-stopped. There is no
 * further inference, so this must already be a full envelope — not an
 * instruction asking the finished worker to summarize.
 */
export function forcedStopReport(
  reason:
    | "no-progress"
    | "turn-budget"
    | "never-acted"
    | "cancelled"
    | "deadline"
    | "thrash"
    | "stalled"
    | "repetition",
  partialText: string,
): string {
  const summary =
    reason === "no-progress"
      ? "Stopped: repeated the same tool calls with no progress."
      : reason === "thrash"
        ? "Stopped: progressive thrash (re-read pressure without finishing)."
        : reason === "never-acted"
          ? "Stopped: completed without using any tools."
          : reason === "cancelled"
            ? "Stopped: cancelled by operator before finishing."
            : reason === "deadline"
              ? "Stopped: wall-clock deadline reached before finishing."
              : reason === "stalled"
                ? "Stopped after a long silence with no tool activity. The parent can re-dispatch or check the background work directly."
                : reason === "repetition"
                  ? "Stopped: degenerate repetition in streamed output (same window looping mid-turn)."
                  : "Turn budget reached before finishing.";
  const blockers =
    reason === "no-progress"
      ? "Identical tool-call fingerprint repeated consecutively; parent may re-dispatch with a tighter brief or different approach."
      : reason === "thrash"
        ? "Re-read pressure (same path after edit, or heavy re-reads amid high tool volume); parent should re-dispatch with a narrower scope, success_criteria, and do_not rather than more turns alone."
        : reason === "never-acted"
          ? "Leaf returned planning/prose only (zero tool calls in the run); parent should re-dispatch with a tighter brief or treat findings as unexecuted."
          : reason === "cancelled"
            ? "Operator or parent cancelled the leaf mid-run; parent may re-dispatch with the partial findings below."
            : reason === "deadline"
              ? "Leaf wall-clock deadline elapsed mid-run; parent may re-dispatch with a longer deadline or a narrower scope for the remaining work."
              : reason === "stalled"
                ? "Leaf went quiet (e.g. parked on a long-running background command) past the stall timeout after an initial nudge; parent may re-dispatch to finish or check on the background work directly."
                : reason === "repetition"
                  ? "The model looped the same output window mid-stream; the tail of the loop is in Findings. Re-dispatching the identical brief will likely loop again — tighten the brief or switch models."
                  : "Leaf turn budget exhausted; parent may re-dispatch for remaining work.";
  // Demote nested report-section headings so runSubAgent's parse/format pass
  // cannot clobber this outer Summary/Blockers with an agent-shaped envelope
  // stuffed into Findings (never-acted planning envelopes; cancel after a
  // structured partial).
  const findings =
    partialText.trim().length > 0
      ? demoteNestedReportHeadings(partialText.trim())
      : "(no partial findings on the final turn)";
  return formatSubAgentReport({
    summary,
    findings,
    blockers,
    paths: "",
  });
}

/** Demote ## Summary|Findings|Blockers|Paths lines so nested envelopes stay under Findings. */
export function demoteNestedReportHeadings(text: string): string {
  // Match parseSubAgentReport: flexible whitespace + case-insensitive section names.
  return text.replace(/^##\s+(Summary|Findings|Blockers|Paths)\b/gim, "### $1");
}

/** True when the worker returned a turn-budget salvage report for the parent. */
export function isTurnBudgetSubAgentReport(report: string): boolean {
  const parsed = parseSubAgentReport(report);
  return parsed.summary.includes("Turn budget reached");
}

/** True when the worker returned a never-acted salvage report for the parent. */
export function isNeverActedSubAgentReport(report: string): boolean {
  const parsed = parseSubAgentReport(report);
  return parsed.summary.includes("without using any tools");
}

/** True when the worker returned a deadline salvage report for the parent. */
export function isDeadlineSubAgentReport(report: string): boolean {
  const parsed = parseSubAgentReport(report);
  return parsed.summary.includes("deadline reached");
}

/** True when the worker returned a progressive-thrash salvage report. */
export function isThrashSubAgentReport(report: string): boolean {
  const parsed = parseSubAgentReport(report);
  return parsed.summary.includes("progressive thrash");
}

/** True when the worker returned a streamed-repetition salvage report. */
export function isRepetitionSubAgentReport(report: string): boolean {
  const parsed = parseSubAgentReport(report);
  return parsed.summary.includes("degenerate repetition");
}

const TURN_BUDGET_PARENT_HINT =
  "[Sub-agent hit its turn budget before finishing. Continue from Findings rather than redoing completed work; re-dispatch with continuation context and a higher maxTurns if more work is warranted.]";

const NEVER_ACTED_PARENT_HINT =
  "[Sub-agent finished without using any tools (planning/prose only). Treat findings as unexecuted; re-dispatch with a tighter brief if the work still needs doing.]";

const DEADLINE_PARENT_HINT =
  "[Sub-agent hit an explicit wall-clock deadline before finishing. Continue from Findings rather than redoing completed work; re-dispatch with continuation context and a longer deadline only if more wall-clock time is warranted.]";

const THRASH_PARENT_HINT =
  "[Sub-agent stopped for progressive thrash (re-read pressure). Do not only raise maxTurns — re-dispatch with a narrower scope, success_criteria, and do_not; continue from Findings.]";

const REPETITION_PARENT_HINT =
  "[Sub-agent aborted after its streamed output degenerated into a loop. Do not re-dispatch the identical brief — it will likely loop again; tighten the brief or use a different model tier.]";

export function appendTurnBudgetParentHint(report: string): string {
  if (!isTurnBudgetSubAgentReport(report)) return report;
  return `${TURN_BUDGET_PARENT_HINT}\n\n${report}`;
}

export function appendNeverActedParentHint(report: string): string {
  if (!isNeverActedSubAgentReport(report)) return report;
  return `${NEVER_ACTED_PARENT_HINT}\n\n${report}`;
}

export function appendDeadlineParentHint(report: string): string {
  if (!isDeadlineSubAgentReport(report)) return report;
  return `${DEADLINE_PARENT_HINT}\n\n${report}`;
}

export function appendThrashParentHint(report: string): string {
  if (!isThrashSubAgentReport(report)) return report;
  return `${THRASH_PARENT_HINT}\n\n${report}`;
}

export function appendRepetitionParentHint(report: string): string {
  if (!isRepetitionSubAgentReport(report)) return report;
  return `${REPETITION_PARENT_HINT}\n\n${report}`;
}

/** Stack parent-visible salvage hints for thrash / budget / never-acted / deadline / repetition. */
export function appendSubAgentParentHints(report: string): string {
  return appendDeadlineParentHint(
    appendNeverActedParentHint(
      appendTurnBudgetParentHint(
        appendThrashParentHint(appendRepetitionParentHint(report)),
      ),
    ),
  );
}


const REPORT_FORCED_WRAP_UP_NUDGE =
  "You are close to your turn budget. Stop calling tools and write your final report now: summarize what you did, your findings, and any blockers.";

function reportForcedNudgeTurn(): ConversationTurn {
  return {
    role: "user",
    content: [{ type: "text", text: REPORT_FORCED_WRAP_UP_NUDGE }],
    timestamp: Date.now(),
  };
}

const SUBAGENT_STALL_NUDGE =
  "No activity has been observed for a while. If you are waiting on a " +
  "background command, check its status now; otherwise continue working or " +
  "write your report.";

function inferWithSubAgentNudge(capabilities: ReactorCapabilities, text: string): ReactorAction {
  const options: ExtendedInferenceOptions = {
    ephemeralTurns: [
      { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
    ],
  };
  return capabilities.infer(options);
}

/**
 * Attach the wrap-up nudge to an existing infer action's options rather than
 * building a fresh infer — a tool_use turn must be followed by tool_result,
 * never a bare user turn, so the nudge can only ride the infer that follows
 * once the pending tool calls have actually executed.
 */
function withReportForcedNudge(options: InferenceOptions | undefined): ExtendedInferenceOptions {
  return { ...(options ?? {}), ephemeralTurns: [reportForcedNudgeTurn()] };
}

export class SubAgentDirector extends DefaultDirector {
  private readonly compaction: CompactionGovernor;
  private readonly maxTurns: number;
  private readonly repeatLimit: number;
  private turnsCompleted = 0;
  private everHadToolCalls = false;
  private streak: ToolCallStreak = {
    lastFingerprint: undefined,
    consecutiveIdentical: 0,
  };
  private thrashState: ThrashState = EMPTY_THRASH_STATE;
  // Set on a report-forced turn so the follow-up infer (after the pending
  // tool calls from THIS turn have executed) carries the wrap-up nudge.
  // Cannot attach the nudge to this turn's own infer: the model just emitted
  // tool_use blocks, and every provider requires tool_result before the next
  // turn — a bare nudge here would send an invalid conversation.
  private pendingWrapUpNudge = false;

  // Stall management: a leaf that goes quiet (e.g. parked on a long-running
  // background command with nothing else to do) produces no inbound events
  // for the director to react to. The reactor has no proactive "idle" event
  // (directors are pure decide(event, ...) functions — see requestContinuation
  // above), so the run loop periodically pings this same continuation channel
  // and the director only acts on a ping if genuinely nothing happened since
  // the last one. Precedence: this check sits below no-progress / thrash /
  // turn-budget (evaluateSubAgentStop, above) — those fire from real
  // inference.done turns and always take priority; stall pings only ever
  // fire on a continuation message that inference.done/tool.done handling
  // did not already consume this cycle.
  private readonly stallTimeoutMs: number | undefined;
  private readonly now: () => number;
  private lastActivityAt: number;
  private consecutiveStalls = 0;
  private lastAssistantText = "";

  constructor(
    systemPrompt: string,
    toolDefinitions: ToolDefinition[],
    requestContinuation: (() => void) | undefined,
    maxTurns: number,
    repeatLimit: number = DEFAULT_SUBAGENT_REPEAT_LIMIT,
    stallTimeoutMs?: number,
    now: () => number = Date.now,
  ) {
    super(systemPrompt, toolDefinitions, {});
    this.compaction = createCompactionGovernor(requestContinuation);
    this.maxTurns = maxTurns;
    this.repeatLimit = repeatLimit;
    this.stallTimeoutMs = stallTimeoutMs;
    this.now = now;
    this.lastActivityAt = now();
  }

  override async decide(
    event: ReactorInboundEvent,
    state: ReactorState,
    capabilities: ReactorCapabilities,
  ): Promise<ReactorAction | ReactorAction[]> {
    if (this.compaction.resumeAfterCompact(event)) {
      return capabilities.infer();
    }
    const idleCompact = this.compaction.interceptIdleContinuation(event, capabilities);
    if (idleCompact !== null) return idleCompact;
    const recovery = this.compaction.interceptOverflow(event, capabilities);
    if (recovery !== null) return recovery;

    const stallOutcome = this.checkStallPing(event, capabilities);
    if (stallOutcome !== null) return stallOutcome;

    // Keep the running local estimate current on every cycle (tool results and
    // rewrites included). Arming still happens inside noteInferenceDone, which
    // prefers provider usage when present.
    this.compaction.syncFromTurns(state.turns);
    if (event.type === "inference.done") {
      this.lastActivityAt = this.now();
      this.consecutiveStalls = 0;
      this.compaction.noteInferenceDone(event, state.turns);
      this.turnsCompleted++;
      const content = event.turn.content as ReadonlyArray<{
        type: string;
        name?: string;
        arguments?: unknown;
        text?: string;
      }>;
      this.lastAssistantText = lastText(content);
      const fingerprint = fingerprintToolCalls(content);
      this.streak = nextToolCallStreak(this.streak, fingerprint);
      const hasToolCalls = fingerprint !== null;
      if (hasToolCalls) {
        this.everHadToolCalls = true;
        this.thrashState = nextThrashState(this.thrashState, content);
      }

      const stop = evaluateSubAgentStop({
        hasToolCalls,
        everHadToolCalls: this.everHadToolCalls,
        turnsCompleted: this.turnsCompleted,
        maxTurns: this.maxTurns,
        consecutiveIdentical: this.streak.consecutiveIdentical,
        repeatLimit: this.repeatLimit,
        thrashState: this.thrashState,
      });

      if (stop === "complete") {
        const terminal: ReactorAction[] = [
          capabilities.checkpoint("subagent-complete"),
          capabilities.reply(lastText(content)),
        ];
        this.compaction.noteIdleTurn(event, terminal);
        const compacted = this.compaction.interceptActions(event, terminal, capabilities);
        if (compacted !== null) return compacted;
        return terminal;
      }
      if (stop === "report-forced") {
        // Not a stop: let the pending tool calls execute as normal (deferring
        // to super.decide below), and arm the nudge for the infer that
        // follows once their results land. Turn-budget stays reachable —
        // this fires once, forceReportWithin turns before the cap.
        this.pendingWrapUpNudge = true;
      } else if (
        stop === "no-progress" ||
        stop === "turn-budget" ||
        stop === "never-acted" ||
        stop === "thrash"
      ) {
        const checkpoint =
          stop === "no-progress"
            ? "subagent-no-progress"
            : stop === "never-acted"
              ? "subagent-never-acted"
              : stop === "thrash"
                ? "subagent-thrash"
                : "subagent-turn-budget";
        const terminal: ReactorAction[] = [
          capabilities.checkpoint(checkpoint),
          capabilities.reply(forcedStopReport(stop, lastText(content))),
        ];
        this.compaction.noteIdleTurn(event, terminal);
        const compacted = this.compaction.interceptActions(event, terminal, capabilities);
        if (compacted !== null) return compacted;
        return terminal;
      }
    }
    if (event.type === "tool.done") {
      this.lastActivityAt = this.now();
      this.consecutiveStalls = 0;
    }
    const base = await super.decide(event, state, capabilities);
    const actions = this.applyPendingWrapUpNudge(
      Array.isArray(base) ? base : [base],
      capabilities,
    );
    return this.compaction.interceptActions(event, actions, capabilities) ?? actions;
  }

  /**
   * Reacts to the periodic stall-check ping (an empty-content continuation,
   * same channel compaction uses to re-enter an idle reactor) started by the
   * run loop when stallTimeoutMs is configured. Only ever sees this event
   * when the reactor is genuinely between cycles — a ping delivered while a
   * tool call is still executing simply queues until that cycle finishes, so
   * "no pending harness-tracked work" falls out of when this method can run
   * at all rather than needing separate bookkeeping.
   *
   * First stall past the timeout: one continuation nudge, asking the leaf to
   * report status or keep going. A second consecutive stall (no activity
   * since the nudge) escalates to the existing salvage path, same shape as
   * no-progress/turn-budget/thrash above. Returns null when this event is not
   * a stall check the director should act on (let it fall through as an
   * ordinary continuation).
   */
  private checkStallPing(
    event: ReactorInboundEvent,
    capabilities: ReactorCapabilities,
  ): ReactorAction[] | null {
    if (this.stallTimeoutMs === undefined) return null;
    if (event.type !== "message.received") return null;
    const content = event.message.content;
    if (typeof content !== "string" || content.length > 0) return null;
    const elapsed = this.now() - this.lastActivityAt;
    if (elapsed < this.stallTimeoutMs) return null;

    this.consecutiveStalls++;
    if (this.consecutiveStalls === 1) {
      return [
        capabilities.checkpoint("subagent-stall-nudge"),
        inferWithSubAgentNudge(capabilities, SUBAGENT_STALL_NUDGE),
      ];
    }
    const terminal: ReactorAction[] = [
      capabilities.checkpoint("subagent-stalled"),
      capabilities.reply(forcedStopReport("stalled", this.lastAssistantText)),
    ];
    return terminal;
  }

  /**
   * Rewrite the infer action in a fall-through actions batch to carry the
   * armed wrap-up nudge, once — this only ever matches the infer that
   * follows the report-forced turn's tool results (super.decide only emits
   * infer once pendingToolResults reaches zero).
   */
  private applyPendingWrapUpNudge(
    actions: ReactorAction[],
    capabilities: ReactorCapabilities,
  ): ReactorAction[] {
    if (!this.pendingWrapUpNudge) return actions;
    const inferIndex = actions.findIndex((action) => action.type === "infer");
    if (inferIndex === -1) return actions;
    this.pendingWrapUpNudge = false;
    const existing = actions[inferIndex] as Extract<ReactorAction, { type: "infer" }>;
    const rewritten = [...actions];
    rewritten[inferIndex] = capabilities.infer(withReportForcedNudge(existing.options));
    return rewritten;
  }
}



export type SubAgentProvider = {
  providerName: string;
  baseURL: string;
  apiKey?: string;
  keyless?: boolean;
  model: string;
  // Subagents inherit the parent's reasoning effort so a /agent selection
  // applies to delegated work, not just the top-level loop.
  reasoningEffort?: ReasoningEffort;
  // Mirrors ProviderCatalogEntry.bifrostVirtualKey. Without it the generic
  // (no-tier) dispatch path builds a plain openai-compatible source and the
  // gateway never receives the x-bf-vk header.
  bifrostVirtualKey?: boolean;
};

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

// Dependencies an orchestrator sub-agent needs to spawn further workers via
// `task`. Nested dispatch always sets allowOrchestrator: false so the
// recursion bottoms out at one hop of orchestration.
export type SubAgentSandboxDeps = {
  permissionGate: PermissionGate;
  inheritMcpTools?: () => readonly AgentTool[];
  shellTimeout?: ShellTimeoutConfig;
  extraToolPlugins?: ToolPlugin[];
  /** Parent session blob store for bounded tool-output:// reads in workers. */
  getBlobReader?: () => BlobReader | undefined;
  /** Project settings.env, merged into the sub-agent's run_shell spawn environment. */
  shellEnv?: Record<string, string>;
};

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
};

/** Typed spawn intent — optional on `task`; omit Intent section when unset. */
export type TaskIntent = "explore" | "implement" | "review" | "plan" | "general";

export type RunSubAgentParams = {
  cwd: string;
  workdirBase: string;
  provider: SubAgentProvider;
  tier?: ProviderTier;
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
  // When true, the assembled system prompt grants this sub-agent permission
  // to call `task` to spawn further agents (orchestrator exception to the
  // no-recursion rule). Set from AgentProfile.orchestrator at dispatch time.
  // Requires nestedDispatch so the task tool can actually be installed —
  // advertising permission without the tool is a hard break.
  orchestrator?: boolean;
  // Present only when orchestrator is true. Installs task + search_agents so
  // the orchestrator can actually dispatch workers.
  nestedDispatch?: NestedDispatchDeps;
  // Set when this dispatch is a nested worker spawned by an orchestrator that
  // already holds a concurrency slot. The nested run reuses the parent's slot
  // (reentrant) instead of acquiring its own, which would deadlock the pool.
  nested?: boolean;
  /** Inference-turn budget for this worker only (not the parent session limit). */
  maxTurns?: number;
  /**
   * Optional wall-clock budget for this worker's whole run (ms). Opt-in only —
   * there is no default leaf death clock; omit to bound the run with maxTurns
   * and operator cancel alone.
   */
  deadlineMs?: number;
} & SubAgentSandboxDeps;

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

// Extract the tool name from a sub-agent stream event. tool.start carries the
// call name at execution time; counting starts only (not ends) keeps the
// activity summary at one entry per invocation.
export function subAgentToolName(event: ReactorEmittedEvent): string | null {
  if (event.type !== "tool.start") return null;
  const call = (event as { data?: { call?: { name?: unknown } } }).data?.call;
  if (typeof call?.name === "string" && call.name.length > 0) return call.name;
  return null;
}

// Append a short activity footer so the parent model (and the operator reading
// the tool result) can see what the sub-agent actually did. Without this the
// only signal is the free-form reply, which models often omit tool details from.
export function appendActivitySummary(reply: string, toolNames: readonly string[]): string {
  if (toolNames.length === 0) return reply;
  const counts = new Map<string, number>();
  for (const name of toolNames) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([name, n]) => (n > 1 ? `${name}×${n}` : name));
  return `${reply}\n\n[tools: ${parts.join(", ")}]`;
}

// Build the user message handed to a sub-agent. Separates durable context from
// the actionable goal so workers follow the brief instead of treating one
// free-form blob as optional color. Optional goals seed a checklist hint
// (manage_tasks on the child owns the real list). Typed spawn fields
// (intent / success_criteria / do_not / report_focus) are rendered only when set.
export type DispatchBrief = {
  description: string;
  prompt: string;
  context?: string;
  goals?: readonly string[];
  intent?: TaskIntent;
  successCriteria?: readonly string[];
  doNot?: readonly string[];
  reportFocus?: string;
};

export function buildDispatchBrief(brief: DispatchBrief): string {
  const parts: string[] = [
    `# Dispatch brief: ${brief.description}`,
    "",
    "## Goal",
    brief.prompt,
  ];
  if (brief.context !== undefined && brief.context.trim().length > 0) {
    parts.push("", "## Context", brief.context.trim());
  }
  // Omit Intent when unset for back-compat (do not default-render "general").
  if (brief.intent !== undefined) {
    parts.push("", "## Intent", brief.intent);
  }
  // Prefer success_criteria as the done-definition; goals stay as checklist seed.
  if (brief.successCriteria !== undefined && brief.successCriteria.length > 0) {
    parts.push(
      "",
      "## Success criteria",
      "Treat these as the done-definition — when all are met (or blocked), stop tools and emit the report envelope:",
      ...brief.successCriteria.map((c, i) => `${i + 1}. ${c}`),
    );
  }
  if (brief.doNot !== undefined && brief.doNot.length > 0) {
    parts.push(
      "",
      "## Do not",
      ...brief.doNot.map((d, i) => `${i + 1}. ${d}`),
    );
  }
  if (brief.goals !== undefined && brief.goals.length > 0) {
    parts.push(
      "",
      "## Suggested checklist",
      "Seed these into manage_tasks if the job is multi-step, then work them in order:",
      ...brief.goals.map((g, i) => `${i + 1}. ${g}`),
    );
  }
  const reportLines = [
    "When finished, reply with the ## Summary / ## Findings / ## Blockers / ## Paths envelope from your system prompt. Stay inside this brief.",
  ];
  if (brief.reportFocus !== undefined && brief.reportFocus.trim().length > 0) {
    reportLines.push(`Focus Findings on: ${brief.reportFocus.trim()}`);
  }
  parts.push("", "## Report shape", ...reportLines);
  return parts.join("\n");
}

// Normalize a worker's final text into the structured report envelope. Missing
// sections fall back so a partial or free-form reply still returns something
// useful to the parent instead of a raw dump.
export type SubAgentReport = {
  summary: string;
  findings: string;
  blockers: string;
  paths: string;
};

export function parseSubAgentReport(reply: string): SubAgentReport {
  const text = reply.trim();
  const sections: Record<string, string> = {};
  const headingRe = /^##\s+(Summary|Findings|Blockers|Paths)\s*$/gim;
  const matches = [...text.matchAll(headingRe)];
  if (matches.length === 0) {
    return {
      summary: text.length > 0 ? text : "Sub-agent finished without a textual result.",
      findings: "",
      blockers: "",
      paths: "",
    };
  }
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const name = m[1]!.toLowerCase();
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? text.length) : text.length;
    sections[name] = text.slice(start, end).trim();
  }
  return {
    summary: sections.summary ?? "",
    findings: sections.findings ?? "",
    blockers: sections.blockers ?? "",
    paths: sections.paths ?? "",
  };
}

export function formatSubAgentReport(report: SubAgentReport): string {
  const lines: string[] = ["## Summary", report.summary.length > 0 ? report.summary : "(no summary)"];
  if (report.findings.length > 0) {
    lines.push("", "## Findings", report.findings);
  }
  if (report.blockers.length > 0) {
    lines.push("", "## Blockers", report.blockers);
  }
  if (report.paths.length > 0) {
    lines.push("", "## Paths", report.paths);
  }
  return lines.join("\n");
}

export type SubAgentRunController = {
  signal: AbortSignal;
  deadlineHit: () => boolean;
  /** Abort the run from inside (e.g. repetition detection), distinct from parent cancel and deadline. */
  abort: (reason: Error) => void;
  dispose: () => void;
};

/**
 * Combines an optional caller cancel signal with an optional opt-in wall-clock
 * deadline into one abort signal. The run has a single signal to check while
 * still being able to tell a genuine cancel apart from the deadline firing
 * (deadlineHit()) when picking a forcedStopReport reason. When deadlineMs is
 * omitted, no timer is armed — maxTurns + cancel remain the only bounds.
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
    dispose: (): void => {
      if (timer !== undefined) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

// Spin up an isolated, autonomous agent loop against the same working tree,
// hand it one task, and return its final report. The sub-agent shares the
// dispatcher's cwd so its edits land in the real repo, but gets its own posix
// tool instances and its own git-backed context store so the two loops never
// trample each other's state.
export async function runSubAgent(params: RunSubAgentParams): Promise<string> {
  return withSubAgentSlot(() => runSubAgentInner(params), {
    reentrant: params.nested === true,
  });
}

async function runSubAgentInner(params: RunSubAgentParams): Promise<string> {
  await seedPricingMetadataFromCache({
    cachePath: defaultPricingCachePath(),
  });

  const permissionGate = params.permissionGate;
  const spawnRegistry = createSubAgentSpawnRegistryPlugin();
  // Child tools resolve spills against the child's own store first, then the
  // parent's (CL-4323): parent tool-output:// URIs handed in the brief must
  // remain readable after spawn, and the child's own spills stay local.
  let childBlobReader: BlobReader | undefined;
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
      ...(params.shellTimeout !== undefined ? { shellTimeout: params.shellTimeout } : {}),
      ...(params.shellEnv !== undefined ? { shellEnv: params.shellEnv } : {}),
      readFileGuard: { blobReader: sessionBlobReader },
      extraToolPlugins: [
        ...(params.extraToolPlugins ?? []),
        spawnRegistry.plugin,
      ],
    }),
  });

  let agent: Awaited<ReturnType<typeof createAgent>> | null = null;
  let streamPromise: Promise<void> | undefined;
  let closeOnAbort: (() => void) | undefined;
  // Declared before try (same reasoning as closeOnAbort above): assigned once
  // requestContinuation/modelFamilyPolicy exist inside the try, but must be
  // visible to the finally block, which is a sibling scope, not a child.
  let stallWatchdog: ReturnType<typeof setInterval> | undefined;
  // Combines the caller's cancel signal with an optional opt-in wall-clock
  // deadline so a leaf that hits the deadline can still return a salvage report
  // rather than racing the outer per-tool-call watchdog (which would discard the
  // run wholesale). When deadlineMs is omitted, no timer is armed — maxTurns +
  // cancel remain the only bounds. Declared before try so finally can dispose.
  const resolvedDeadlineMs =
    params.deadlineMs !== undefined
      ? resolveSubAgentDeadlineMs(
          params.deadlineMs,
          resolveToolExecutionTimeoutMs(toolWatchdogFromSettings(params.settings)),
        )
      : undefined;
  const runController = createSubAgentRunController(params.signal, resolvedDeadlineMs);

  try {
  const shellDefaultMs = params.shellTimeout?.defaultMs;
  let tools = fromToolRunner(posixTools).map((tool) => ({
    ...tool,
    definition: advertiseEditFileLineRange(advertiseShellGuardTimeout(tool.definition, shellDefaultMs)),
  }));

  tools = [...tools, ...coreSubAgentWebTools()];

  const inherited = params.inheritMcpTools?.() ?? [];
  if (inherited.length > 0) {
    tools = [...tools, ...inherited];
  }

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
        const parsed = parseManageTasksArgs(rawArgs);
        if (parsed === null) {
          return "Error: manage_tasks requires action ('create' or 'update').";
        }
        return "Tasks updated.";
      },
    }),
  ];

  // Orchestrators need task + search_agents installed, not just mentioned in
  // the prompt. Nested dispatch always forbids further orchestration so the
  // tree bottoms out after one hop.
  if (params.orchestrator === true) {
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
        ...(nd.onEvent !== undefined ? { onEvent: nd.onEvent } : {}),
        ...(nd.onProgress !== undefined ? { onProgress: nd.onProgress } : {}),
        ...(nd.sessions !== undefined ? { sessions: nd.sessions } : {}),
        ...(nd.settings !== undefined ? { settings: nd.settings } : {}),
        ...(nd.catalog !== undefined ? { catalog: nd.catalog } : {}),
        ...(nd.profiles !== undefined ? { profiles: nd.profiles } : {}),
        ...(nd.parentSessionId !== undefined ? { parentSessionId: nd.parentSessionId } : {}),
      }),
      ...(nd.profiles !== undefined
        ? [
            createSearchAgentsTool(() => {
              const profiles = nd.profiles;
              return typeof profiles === "function" ? profiles() : (profiles ?? []);
            }),
          ]
        : []),
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


  let agentHandle: Awaited<ReturnType<typeof createAgent>> | null = null;
  const requestContinuation = (): void => {
    try {
      agentHandle?.deliver({
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
      });
    } catch {
      // Agent may be closing; a dropped continuation is harmless.
    }
  };

  const maxTurns =
    params.maxTurns ?? resolveDefaultSubAgentMaxTurns(params.settings);

  const modelFamilyPolicy = resolveModelFamilyPolicy({
    providerName: params.provider.providerName,
    model: params.provider.model,
    orchestrator: params.orchestrator === true,
  });

  const directorDef = defineDirector({
    id: `${ID_PREFIX}/subagent`,
    configSchema: type({}),
    factory: (_config, _env, agentCtx) =>
      new SubAgentDirector(
        agentCtx.systemPrompt,
        [...agentCtx.toolDefinitions],
        requestContinuation,
        maxTurns,
        DEFAULT_SUBAGENT_REPEAT_LIMIT,
        modelFamilyPolicy.subAgentStallTimeoutMs,
      ),
  });

  // Directors are pure decide(event, ...) functions with no timer of their
  // own (see checkStallPing on SubAgentDirector), so a silent leaf needs an
  // external nudge to even get a decide() call. Ping the same continuation
  // channel compaction uses at the stall interval; the director only acts on
  // a ping if nothing happened since the last one.
  stallWatchdog = setInterval(() => requestContinuation(), modelFamilyPolicy.subAgentStallTimeoutMs);
  if (typeof stallWatchdog.unref === "function") stallWatchdog.unref();

  const toolsFactory = defineTool({
    id: `${ID_PREFIX}/subagent-tools`,
    // Without the watchdog config, child tool calls run under default budgets
    // and ignore tools.timeoutMs / maxTimeoutMs / waitForApproval settings.
    factory: () => createDynamicToolRunner(tools, toolWatchdogFromSettings(params.settings)),
  });

  const workdir = join(params.workdirBase, "subagents", generateSessionId());
  await mkdir(workdir, { recursive: true });

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
    params.tier !== undefined && params.settings !== undefined && params.catalog !== undefined
      ? buildSubagentSources({
          settings: params.settings,
          catalog: params.catalog,
          tier: params.tier,
          head,
          ...(params.provider.reasoningEffort !== undefined
            ? { reasoningEffort: params.provider.reasoningEffort }
            : {}),
        })
      : buildSubAgentPrimarySource(params.provider, params.catalog, params.settings);
  const inferenceDeps = await createInferenceDependencies();
  const subagentSource =
    bundle.sources.find((s) => s.id === bundle.defaultSource) ?? bundle.sources[0];
  agent = await createAgent(def, {
    sources: bundle.sources,
    defaultSource: bundle.defaultSource,
    storage,
    workdir,
    // contextTransforms ride deps: the published @intx/agent forwards deps
    // into reactor assembly verbatim, and the vendored assembly picks the
    // transforms up from there.
    deps: {
      ...inferenceDeps,
      contextTransforms: [
        createAttachmentRehydrateTransform((key) => storage.readBlob(key)),
      ],
    },
    audit: noopAuditStore(),
    authorize: permissiveAuthorize(),
    directors: createDirectorRegistry({
      factories: [directorDef.factory],
      defaultId: `${ID_PREFIX}/subagent`,
    }),
    compactors: {
      "pruning-compactor": createPruningCompactor({
        keepRecentTurns: 6,
        summaryMaxChars: 2500,
        stripResultContent: true,
        // A structured model summary keeps sub-agent context useful across a
        // compaction; the deterministic stub remains the fallback on failure.
        ...(subagentSource !== undefined
          ? { summarize: createModelSummarizer({ getSource: () => subagentSource, deps: inferenceDeps }) }
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
  // Watch the streamed text of the in-flight cycle: turn-level stop checks
  // (inference.done) never fire while a model loops inside one turn, so a
  // degenerate loop is aborted from the stream side. The recorder keeps the
  // cycle text so the looped tail survives the abort as the salvage payload.
  const cycleRecorder = createCycleTextRecorder(() => workdir, appendCycleText);
  let repetitionHit: RepetitionHit | null = null;
  const streamSink = (event: ReactorEmittedEvent): void => {
    const name = subAgentToolName(event);
    if (name !== null) {
      toolNamesUsed.push(name);
      params.onProgress?.({ description: params.description, toolName: name });
    }
    cycleRecorder.handleEvent(event);
    if (event.type === "inference.text.delta" && repetitionHit === null) {
      const hit = detectRepetition(cycleRecorder.text());
      if (hit !== null) {
        repetitionHit = hit;
        runController.abort(
          new Error(`sub-agent streamed output repeated the same window ${hit.repeats} times`),
        );
      }
    }
    const partial = partialTextFromEvent(event);
    if (partial !== null) lastPartialText = partial;
    params.onEvent?.(event);
  };
  streamPromise = consumeStream(agent.stream(), streamSink);

  // Aborting the send signal only rejects the promise; the child reactor keeps
  // running until close() (same hard-stop rule as the parent in runner.tsx).
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
    });
    const ensureNotAborted = (): void => {
      // Re-read .aborted after await — control-flow narrowing would wrongly
      // treat a pre-send check as permanent.
      if (runController.signal.aborted) throw abortError(runController.signal);
    };
    try {
      ensureNotAborted();
      const sendOpts = { signal: runController.signal };
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
      return appendActivitySummary(report, toolNamesUsed);
    } catch (err) {
      if (isSubAgentCancelError(err, runController.signal)) {
        // Drain stream events so tool.start / inference.done that already
        // left the reactor are reflected before we decide bare vs salvage.
        if (streamPromise !== undefined) {
          await streamPromise.catch(() => {});
        }
        // Deadline always salvages (even with zero output). Cancel after any
        // tools or assistant prose salvages so the parent keeps partial work;
        // pre-progress cancel still surfaces as a bare AbortError.
        const hadProgress =
          toolNamesUsed.length > 0 || lastPartialText.trim().length > 0;
        const outcome = resolveSubAgentCatchOutcome({
          deadlineHit: runController.deadlineHit(),
          hadProgress,
          repetitionHit: repetitionHit !== null,
        });
        // The cycle that died never reached inference.done, so its text exists
        // only in the recorder. Persist it before building the report.
        const abortedCycleText = cycleRecorder.text();
        await cycleRecorder.flush(
          outcome === "salvage-repetition"
            ? "repetition"
            : outcome === "salvage-deadline"
              ? "deadline"
              : "cancelled",
        );
        if (outcome !== "rethrow") {
          const reason =
            outcome === "salvage-repetition"
              ? "repetition"
              : outcome === "salvage-deadline"
                ? "deadline"
                : "cancelled";
          const partial =
            lastPartialText.trim().length > 0 ? lastPartialText : abortedCycleText.slice(-2000);
          return appendActivitySummary(forcedStopReport(reason, partial), toolNamesUsed);
        }
      }
      throw err;
    }
  } finally {
    if (stallWatchdog !== undefined) clearInterval(stallWatchdog);
    runController.dispose();
    await disposeSubAgentSession({
      signal: runController.signal,
      ...(closeOnAbort !== undefined ? { closeOnAbort } : {}),
      agent,
      ...(streamPromise !== undefined ? { streamPromise } : {}),
      posixTools,
    });
  }
}


function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" && reason.length > 0 ? reason : "aborted");
  err.name = "AbortError";
  return err;
}

export function isSubAgentCancelError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  if (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError") {
    return true;
  }
  return false;
}

/** Wall-clock wait for in-flight plugin tool calls to finish before posix dispose. */
export const SUBAGENT_SPAWN_DRAIN_MS = 2_000;

/**
 * Honest limits for plugin-spawn teardown (for operator docs and output notes).
 * Corbits Code can dispose posix tools and LSP sidecars per sub-agent session; OS
 * children spawned inside shell-guard and ripgrep middleware are aborted via the
 * tool AbortSignal on cancel/close but are not centrally registered without
 * upstream spawn hooks on those plugins.
 */
export const SUBAGENT_PLUGIN_SPAWN_TEARDOWN_LIMITS =
  "Per sub-agent session Corbits Code runs agent.close(), drains in-flight tool middleware (best-effort), then posixTools.dispose() (LSP and plugin dispose callbacks). " +
  "run_shell and ripgrep spawns honor AbortSignal process-group kill but are not tracked in a global registry until shell-guard/ripgrep expose spawn hooks.";

export type SubAgentSpawnSnapshot = {
  inFlightToolCalls: number;
  inFlightByTool: Readonly<Record<string, number>>;
};

const PLUGIN_SPAWN_TRACKED_TOOLS = new Set(["run_shell", "grep", "search_files"]);

export type SubAgentSpawnRegistry = {
  plugin: ToolPlugin;
  snapshot: () => SubAgentSpawnSnapshot;
};

/** Middleware plugin: visibility for plugin-layer tool calls that may spawn children. */
export function createSubAgentSpawnRegistryPlugin(): SubAgentSpawnRegistry {
  const inFlight = new Map<string, number>();
  const bump = (name: string, delta: number): void => {
    const next = (inFlight.get(name) ?? 0) + delta;
    if (next <= 0) inFlight.delete(name);
    else inFlight.set(name, next);
  };
  const snapshot = (): SubAgentSpawnSnapshot => {
    let total = 0;
    const byTool: Record<string, number> = {};
    for (const [name, count] of inFlight) {
      total += count;
      byTool[name] = count;
    }
    return { inFlightToolCalls: total, inFlightByTool: byTool };
  };
  const plugin: ToolPlugin = {
    middleware: (next) => async (call, signal) => {
      const track = PLUGIN_SPAWN_TRACKED_TOOLS.has(call.name);
      if (track) bump(call.name, 1);
      try {
        return await next(call, signal);
      } finally {
        if (track) bump(call.name, -1);
      }
    },
    dispose: async () => {
      const deadline = Date.now() + SUBAGENT_SPAWN_DRAIN_MS;
      while (snapshot().inFlightToolCalls > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
  return { plugin, snapshot };
}

export type SubAgentSessionDisposeInput = {
  signal?: AbortSignal | undefined;
  closeOnAbort?: (() => void) | undefined;
  agent: { close(): Promise<void> } | null;
  streamPromise?: Promise<void> | undefined;
  posixTools: { dispose(): Promise<void> };
};

/** Idempotent teardown for one sub-agent loop (completion, error, or cancel). */
export async function disposeSubAgentSession(input: SubAgentSessionDisposeInput): Promise<void> {
  if (input.signal !== undefined && input.closeOnAbort !== undefined) {
    input.signal.removeEventListener("abort", input.closeOnAbort);
  }
  try {
    await input.agent?.close();
  } catch {
    // ignore
  }
  try {
    await input.streamPromise;
  } catch {
    // ignore
  }
  try {
    await input.posixTools.dispose();
  } catch {
    // LSP shutdown can fail when several sub-agents exit together.
  }
}

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
    "Spawn a sub-agent (a short-lived child agent) for one self-contained job. This is not a checklist item — use manage_tasks for your own work list. The sub-agent has the full file, search, and shell toolset, uses this session's permission gate (saved grants and auto mode when eligible; you may be prompted for other consequential actions), and returns a structured report (Summary / Findings / Blockers / Paths). Use it to parallelize exploration (\"map every caller of X\") or hand off a well-scoped implementation so your own context stays focused. Fire several task calls in one turn to run sub-agents in parallel. When launching multiple agents with the same profile, assign each a distinct lens in description and prompt so they do not duplicate work. The sub-agent cannot ask you questions and shares your working tree. Write a clear brief: context = durable background; prompt = actionable goal; goals = optional manage_tasks seeds. Prefer the typed spawn contract so leaves finish without thrashing: intent (explore|implement|review|plan|general), success_criteria (done-when checklist), do_not (scope fence), report_focus (what Findings must cover).",
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
  // Injectable for tests; defaults to the real runSubAgent.
  run?: (params: RunSubAgentParams) => Promise<string>;
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
};

function taskToolResult(callId: string, content: string): ToolResult {
  const isError = content.startsWith("Error:") || content.startsWith("Error ");
  return { callId, content, ...(isError ? { isError: true } : {}) };
}

export function createTaskTool(deps: TaskToolDeps): AgentTool {
  const run = deps.run ?? runSubAgent;
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

      try {
        const params: RunSubAgentParams = {
          ...sandbox,
          cwd: deps.cwd,
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
        if (wasCancelled) {
          if (
            session !== undefined &&
            deps.sessions?.get(session.id)?.status === "running"
          ) {
            deps.sessions.cancel(session.id, cancelReason(childCtl.signal));
          }
          const reported = appendSubAgentParentHints(result);
          return taskToolResult(
            call.id,
            `Sub-agent "${description}" reported:\n\n${reported}`,
          );
        }
        if (session !== undefined) deps.sessions?.complete(session.id, result);
        const reported = appendSubAgentParentHints(result);
        return taskToolResult(call.id, `Sub-agent "${description}" reported:\n\n${reported}`);


      } catch (err) {
        if (
          isSubAgentCancelError(err, childCtl.signal) ||
          (session !== undefined &&
            deps.sessions?.get(session.id)?.status === "cancelled")
        ) {
          if (
            session !== undefined &&
            deps.sessions?.get(session.id)?.status === "running"
          ) {
            deps.sessions.cancel(session.id, cancelReason(childCtl.signal));
          }
          return taskToolResult(call.id, cancelledSubAgentMessage(description));
        }
        const authMessage = formatSubAgentTaskAuthFailureMessage(description, err);
        const message =
          authMessage !== null
            ? `Error: ${authMessage}`
            : `Error: sub-agent "${description}" failed: ${err instanceof Error ? err.message : String(err)}`;
        const sessionError = err instanceof Error ? err.message : String(err);
        // fail() prefixes "Error:" on the transcript report entry — pass bare text.
        const failReason = authMessage ?? sessionError;
        if (session !== undefined) deps.sessions?.fail(session.id, failReason);
        return taskToolResult(call.id, message);
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