/**
 * Behavior metrics derived from the product run's turn stream.
 *
 * Pure functions only: the eval runner captures the post-run summary (turns
 * with tool calls and assistant content) and hands it here for derivation.
 * Command analysis is a quote-aware token scan, not a full shell parser —
 * substitutions inside `$(...)` and backticks are treated as opaque text.
 */

import { type } from "arktype";
import { splitChainedCommand } from "../../src/permission/command.js";

export const CapturedContentBlock = type({
  type: "string",
  "text?": "string",
});

export const CapturedToolCall = type({
  name: "string",
  "arguments?": "unknown",
});

export const CapturedTurn = type({
  toolCalls: CapturedToolCall.array(),
  assistantTurn: {
    content: CapturedContentBlock.array(),
  },
  durationMs: "number",
});

/** Post-run summary payload captured from the lifecycle hook (subset we read). */
export const CapturedRunSummary = type({
  turns: CapturedTurn.array(),
});

export type CapturedTurn = typeof CapturedTurn.infer;
export type CapturedRunSummary = typeof CapturedRunSummary.infer;

export interface BehaviorMetrics {
  /** run_shell calls observed. */
  shellCommandCount: number;
  /** run_shell commands containing an env-var prefix (`FOO=bar cmd`) or `export`. */
  envAssignmentCommandCount: number;
  /** Total chain segments across all run_shell commands (`&&`, `||`, `;`, `|`). */
  chainSegmentCount: number;
  /** Largest chain segment count in a single run_shell command. */
  maxChainSegmentsPerCommand: number;
  /** Segments whose command word is a network fetch tool (curl, wget, ...). */
  networkCommandCount: number;
  /** web_fetch tool calls (0 when the tool is absent or unused). */
  webFetchToolCallCount: number;
  /** spawn_agent tool calls (0 when the tool is absent or unused). */
  spawnAgentToolCallCount: number;
  /** Segments editing files via sed/perl/awk in-place or heredoc redirection. */
  editViaShellCount: number;
  /** Tool calls repeating an earlier call's name with normalized-equal arguments. */
  repeatedSearchCount: number;
  /** Longest run of consecutive assistant turns with tool calls and no text. */
  longestToolOnlyStreak: number;
  /** Slowest single turn (ms) — surfaces stalls waiting on slow commands. */
  maxTurnDurationMs: number;
  /** Per-tool-name call counts for the whole run. */
  toolCallsByName: Record<string, number>;
}

/** Numeric metric keys eligible for min/median/max aggregation and baseline diff. */
export const NUMERIC_BEHAVIOR_METRICS = [
  "shellCommandCount",
  "envAssignmentCommandCount",
  "chainSegmentCount",
  "maxChainSegmentsPerCommand",
  "networkCommandCount",
  "webFetchToolCallCount",
  "spawnAgentToolCallCount",
  "editViaShellCount",
  "repeatedSearchCount",
  "longestToolOnlyStreak",
  "maxTurnDurationMs",
] as const;

export type NumericBehaviorMetric = (typeof NUMERIC_BEHAVIOR_METRICS)[number];

export function isNumericBehaviorMetric(name: string): name is NumericBehaviorMetric {
  return (NUMERIC_BEHAVIOR_METRICS as readonly string[]).includes(name);
}

/**
 * Baseline-diff direction per metric. "lower" means a smaller median is an
 * improvement (the metric counts a misbehavior); "neutral" metrics are
 * informational and never produce improve/regress verdicts.
 */
export const BEHAVIOR_METRIC_DIRECTIONS: Record<NumericBehaviorMetric, "lower" | "neutral"> = {
  shellCommandCount: "neutral",
  envAssignmentCommandCount: "lower",
  chainSegmentCount: "neutral",
  maxChainSegmentsPerCommand: "lower",
  networkCommandCount: "lower",
  webFetchToolCallCount: "neutral",
  spawnAgentToolCallCount: "neutral",
  editViaShellCount: "lower",
  repeatedSearchCount: "lower",
  longestToolOnlyStreak: "lower",
  maxTurnDurationMs: "lower",
};

const NETWORK_COMMANDS = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "telnet",
  "aria2c",
  "http",
  "xh",
  "httpie",
]);
const INPLACE_EDIT_COMMANDS = new Set(["sed", "perl", "awk", "gawk"]);
const SHELL_TOOL_NAME = "run_shell";
const WEB_FETCH_TOOL_NAME = "web_fetch";
const SPAWN_AGENT_TOOL_NAME = "spawn_agent";
const LEGACY_TASK_TOOL_NAME = "task";

/**
 * Split a shell command into chain segments, using the same quote-aware
 * tokenizer the permission gate classifies commands with, so the eval
 * measures what the real gate actually sees.
 */
export const splitChainSegments = splitChainedCommand;

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function segmentWords(segment: string): string[] {
  return segment.split(/\s+/).filter((w) => w.length > 0);
}

/** True when the segment starts with `NAME=value` prefixes or is an `export`. */
export function segmentHasEnvAssignment(segment: string): boolean {
  const words = segmentWords(segment);
  if (words.length === 0) return false;
  if (words[0] === "export") return true;
  return ENV_ASSIGNMENT.test(words[0]!);
}

/** Command word of a segment, skipping env-var prefixes. */
export function segmentCommandWord(segment: string): string | null {
  for (const word of segmentWords(segment)) {
    if (ENV_ASSIGNMENT.test(word)) continue;
    return word;
  }
  return null;
}

export function segmentIsNetworkCommand(segment: string): boolean {
  const word = segmentCommandWord(segment);
  return word !== null && NETWORK_COMMANDS.has(word);
}

/** In-place stream edit (sed/perl/awk with -i) or heredoc-driven file write. */
export function segmentIsShellEdit(segment: string): boolean {
  const words = segmentWords(segment);
  const command = segmentCommandWord(segment);
  if (command !== null && INPLACE_EDIT_COMMANDS.has(command)) {
    if (words.some((w) => w.startsWith("-i"))) return true;
  }
  // Heredoc: unquoted << that is not the here-string <<<.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (
      ch === "<" &&
      !inSingle &&
      !inDouble &&
      segment[i + 1] === "<" &&
      segment[i + 2] !== "<" &&
      segment[i - 1] !== "<"
    ) {
      return true;
    }
  }
  return false;
}

/** Stable, whitespace/case-insensitive normalization for repeat detection. */
export function normalizeToolArguments(args: unknown): string {
  return JSON.stringify(normalizeValue(args));
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === "string") return value.toLowerCase().replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]): [string, unknown] => [k, normalizeValue(v)])
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries);
  }
  return value;
}

function turnHasText(turn: CapturedTurn): boolean {
  return turn.assistantTurn.content.some(
    (block) =>
      block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
  );
}

function shellCommandFromArguments(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" ? command : null;
}

export function deriveBehaviorMetrics(summary: CapturedRunSummary): BehaviorMetrics {
  let shellCommandCount = 0;
  let envAssignmentCommandCount = 0;
  let chainSegmentCount = 0;
  let maxChainSegmentsPerCommand = 0;
  let networkCommandCount = 0;
  let editViaShellCount = 0;
  let repeatedSearchCount = 0;
  let longestToolOnlyStreak = 0;
  let maxTurnDurationMs = 0;
  const toolCallsByName: Record<string, number> = {};
  const seenCalls = new Set<string>();
  let streak = 0;

  for (const turn of summary.turns) {
    maxTurnDurationMs = Math.max(maxTurnDurationMs, turn.durationMs);
    if (turn.toolCalls.length > 0 && !turnHasText(turn)) {
      streak++;
      longestToolOnlyStreak = Math.max(longestToolOnlyStreak, streak);
    } else {
      streak = 0;
    }
    for (const call of turn.toolCalls) {
      toolCallsByName[call.name] = (toolCallsByName[call.name] ?? 0) + 1;
      const signature = JSON.stringify([call.name, normalizeToolArguments(call.arguments)]);
      if (seenCalls.has(signature)) repeatedSearchCount++;
      else seenCalls.add(signature);

      if (call.name !== SHELL_TOOL_NAME) continue;
      const command = shellCommandFromArguments(call.arguments);
      if (command === null) continue;
      shellCommandCount++;
      const segments = splitChainSegments(command);
      chainSegmentCount += segments.length;
      maxChainSegmentsPerCommand = Math.max(maxChainSegmentsPerCommand, segments.length);
      if (segments.some(segmentHasEnvAssignment)) envAssignmentCommandCount++;
      networkCommandCount += segments.filter(segmentIsNetworkCommand).length;
      editViaShellCount += segments.filter(segmentIsShellEdit).length;
    }
  }

  return {
    shellCommandCount,
    envAssignmentCommandCount,
    chainSegmentCount,
    maxChainSegmentsPerCommand,
    networkCommandCount,
    webFetchToolCallCount: toolCallsByName[WEB_FETCH_TOOL_NAME] ?? 0,
    spawnAgentToolCallCount: toolCallsByName[SPAWN_AGENT_TOOL_NAME] ?? 0,
    editViaShellCount,
    repeatedSearchCount,
    longestToolOnlyStreak,
    maxTurnDurationMs,
    toolCallsByName,
  };
}

const BehaviorMetricsType = type({
  shellCommandCount: "number",
  envAssignmentCommandCount: "number",
  chainSegmentCount: "number",
  maxChainSegmentsPerCommand: "number",
  networkCommandCount: "number",
  webFetchToolCallCount: "number",
  "spawnAgentToolCallCount?": "number",
  "taskToolCallCount?": "number",
  editViaShellCount: "number",
  repeatedSearchCount: "number",
  longestToolOnlyStreak: "number",
  maxTurnDurationMs: "number",
  toolCallsByName: { "[string]": "number" },
});

/** Parse a stored behaviors block from a results file; null when absent/invalid. */
export function parseBehaviorMetrics(raw: unknown): BehaviorMetrics | null {
  if (raw === undefined || raw === null) return null;
  const parsed = BehaviorMetricsType(raw);
  if (parsed instanceof type.errors) return null;
  const { taskToolCallCount: legacyTaskToolCallCount, ...current } = parsed;
  // Frozen baseline files predate this field; derive from the per-name map.
  return {
    ...current,
    spawnAgentToolCallCount:
      parsed.spawnAgentToolCallCount ??
      parsed.toolCallsByName[SPAWN_AGENT_TOOL_NAME] ??
      legacyTaskToolCallCount ??
      parsed.toolCallsByName[LEGACY_TASK_TOOL_NAME] ??
      0,
  };
}

/** Parse a captured run summary JSON document at the boundary. */
export function parseCapturedRunSummary(raw: unknown): CapturedRunSummary {
  const parsed = CapturedRunSummary(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid captured run summary: ${parsed.summary}`);
  }
  return parsed;
}
