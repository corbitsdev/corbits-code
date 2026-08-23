// Context curation and compaction for the perpetual session.
//
// Provides:
//   1. A task-boundary classifier that reads the latest user message plus
//      session metadata and emits a structured decision.
//   2. A deterministic compactor (ConversationTurn[] -> ConversationTurn[])
//      that prunes completed-task context while preserving the active task,
//      recent turns, plan state, file/tool references, and unresolved errors.
//   3. A context-envelope builder that produces stable prompt-facing sections
//      for prompt-cache friendliness.
//
// The persisted run history is always kept complete in the context store.
// Only the inference-facing context is curated here.

import type {
  ConversationTurn,
  Compactor,
  StrategyContext,
  StrategyResult,
  StrategyBlob,
} from "@intx/types/runtime";
import { ageImageBlocks } from "./attachment-store.js";
import type { SummaryContext } from "./summarizer.js";

// ---------------------------------------------------------------------------
// Task boundary decision
// ---------------------------------------------------------------------------

export type TaskBoundary =
  | { kind: "same_task"; reason: string }
  | { kind: "new_task"; reason: string }
  | { kind: "unclear"; reason: string };

export type SessionMetadata = {
  turnCount: number;
  currentTaskLabel: string | undefined;
  lastTaskSummary: string | undefined;
  minutesElapsed: number;
  toolCallCount: number;
};

// The classifier is a two-tier approach:
//   Tier 1 — deterministic heuristics (fast, no LLM cost)
//   Tier 2 — LLM-based classification (only when heuristics are ambiguous)
//
// For v1 the heuristic tier is deliberately simple and conservative:
// explicit boundary commands and trivial rules fall through to the LLM tier.

const BOUNDARY_COMMANDS = ["/clear", "/new", "/reset"];

/**
 * Determine the task boundary for a new user message.
 *
 * Tier 1 heuristics run first and return immediately for clear-cut cases:
 * explicit boundary commands produce `new_task`; a very short session or a
 * message that is clearly a continuation produces `same_task`.
 *
 * When heuristics cannot decide, the function uses an LLM classification
 * call via the supplied `classify` function. The classifier is ephemeral
 * (no side effects) and returns a fixed small schema.
 */
export async function classifyTaskBoundary(
  message: string,
  metadata: SessionMetadata,
  classify: (prompt: string) => Promise<{ decision: string; reason: string }>,
): Promise<TaskBoundary> {
  // Tier 1: explicit boundary commands
  const trimmed = message.trim();
  if (BOUNDARY_COMMANDS.includes(trimmed)) {
    return { kind: "new_task", reason: "explicit boundary command" };
  }

  // Tier 1: very early in session, always same task
  if (metadata.turnCount <= 1 && metadata.currentTaskLabel === undefined) {
    return { kind: "same_task", reason: "session just started" };
  }

  // Tier 1: continuation signals (short follow-ups, answers to questions)
  if (trimmed.length < 40 && metadata.turnCount > 0 && metadata.currentTaskLabel !== undefined) {
    // Short messages on an established task are almost certainly continuations.
    return { kind: "same_task", reason: "short continuation message" };
  }

  // Tier 2: LLM classification
  const classifierPrompt = [
    "You are a task-boundary classifier for an AI coding assistant.",
    "Given the latest user message and session metadata, decide whether this",
    "message starts a new task or continues the current one.",
    "",
    "Respond with a JSON object:",
    '{ "decision": "same_task" | "new_task" | "unclear", "reason": "<brief explanation>" }',
    "",
    "Session metadata:",
    JSON.stringify(metadata, null, 2),
    "",
    "Latest user message:",
    trimmed,
    "",
    "Guidelines:",
    "- 'new_task' — the user is pivoting to unrelated work or explicitly starting fresh",
    "- 'same_task' — the user is continuing, refining, or answering about the current work",
    "- 'unclear' — when you genuinely cannot tell (this avoids mis-classification)",
    "- Be conservative: default to 'same_task' or 'unclear' when in doubt",
  ].join("\n");

  try {
    const result = await classify(classifierPrompt);
    const decision = result.decision;
    if (decision === "new_task") {
      return { kind: "new_task", reason: result.reason };
    }
    if (decision === "same_task") {
      return { kind: "same_task", reason: result.reason };
    }
    return { kind: "unclear", reason: result.reason };
  } catch {
    // Classifier failure should not break the session. Default to unclear.
    return { kind: "unclear", reason: "classifier call failed, defaulting to unclear" };
  }
}

// ---------------------------------------------------------------------------
// Context envelope
// ---------------------------------------------------------------------------

/**
 * Stable keys for context envelope sections. The ordering and keys must not
 * change between turns so prompt caching remains effective.
 */
export const CONTEXT_ENVELOPE_SECTIONS = [
  "active-task",
  "task-summary",
  "current-plan",
  "recent-turns",
  "file-references",
  "unresolved-errors",
] as const;

export type ContextEnvelope = {
  /** Label for the current active task, e.g. "Fix login bug" */
  activeTask?: string;
  /** Compacted summary of prior completed tasks */
  taskSummary?: string;
  /** Current plan steps if one is active */
  currentPlan?: string;
  /** Recent conversation turns (N most recent) */
  recentTurns: number;
  /** Files the agent has read or modified */
  fileReferences?: string[];
  /** Any unresolved errors from the current task */
  unresolvedErrors?: string[];
};

/**
 * Build the context-envelope text that gets placed between the system prompt
 * and the conversation history. Stable ordering ensures prompt-cache prefix
 * stability across turns.
 */
export function buildContextEnvelope(envelope: ContextEnvelope): string {
  const sections: string[] = ["--- Context ---"];

  if (envelope.activeTask !== undefined && envelope.activeTask.length > 0) {
    sections.push(`Active task: ${envelope.activeTask}`);
  }

  if (envelope.taskSummary !== undefined && envelope.taskSummary.length > 0) {
    sections.push(`Prior task summary:\n${envelope.taskSummary}`);
  }

  if (envelope.currentPlan !== undefined && envelope.currentPlan.length > 0) {
    sections.push(`Current plan:\n${envelope.currentPlan}`);
  }

  sections.push(`Recent turns shown: ${envelope.recentTurns}`);

  if (envelope.fileReferences !== undefined && envelope.fileReferences.length > 0) {
    sections.push(`Files referenced: ${envelope.fileReferences.join(", ")}`);
  }

  if (envelope.unresolvedErrors !== undefined && envelope.unresolvedErrors.length > 0) {
    sections.push(`Unresolved errors:\n${envelope.unresolvedErrors.join("\n")}`);
  }

  sections.push("---");
  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Compactor
// ---------------------------------------------------------------------------

export type CompactorConfig = {
  keepRecentTurns: number;
  summaryMaxChars: number;
  summarize?: (turns: ConversationTurn[], ctx?: SummaryContext) => Promise<string>;
  /**
   * Read at compaction time and passed to `summarize` so the summary can
   * carry live workflow state (which workflow/step was active when the
   * compacted turns were dropped).
   */
  summaryContext?: () => SummaryContext | undefined;
  // Max older turns to pull forward as anchors (file edits, task updates)
  // before the summary stub. Selected from the end of the older set so the
  // most-recent anchors survive; pair partners count against the cap too.
  maxAnchorTurns: number;
};

// Recent turns kept verbatim by both real pruning-compactor registrations
// (the main session and sub-agents). Exported so callers that need to know
// in advance whether a compaction would do anything — the compaction
// governor's arming floor — derive it from this value instead of carrying
// an independent literal that can silently drift out of sync.
export const COMPACTOR_KEEP_RECENT_TURNS = 6;

const DEFAULT_COMPACTOR_CONFIG: CompactorConfig = {
  keepRecentTurns: COMPACTOR_KEEP_RECENT_TURNS,
  summaryMaxChars: 2000,
  maxAnchorTurns: 8,
};

// `apply` below no-ops at or below this turn count: keeping `keepRecentTurns`
// turns plus at least one more is what makes pruning worth doing at all.
export function compactorNoOpFloor(keepRecentTurns: number): number {
  return keepRecentTurns + 1;
}

// Minimum anchor score for a turn to be pulled forward past the summary boundary.
const ANCHOR_SCORE_THRESHOLD = 5;

// Tool names whose results are path-keyed for re-read dedup during compaction.
const READ_TOOLS = new Set(["read_file"]);

// Replayable query tools deduped by full-argument identity: a later identical
// grep/search_files/list_dir call reflects newer workspace state, so an older
// identical result is stale the same way an older read_file body is.
// run_shell is deliberately excluded — the same command is not idempotent
// (builds, tests, mutations), so an older run_shell result can be the only
// record of a genuinely distinct outcome.
const QUERY_TOOLS = new Set(["grep", "search_files", "list_dir"]);

function isReplayableResultTool(name: string): boolean {
  return READ_TOOLS.has(name) || QUERY_TOOLS.has(name);
}

// Call-id index for stub rendering (name + path). Dedup keys live on `readKey`.
type ToolCallInfo = {
  name: string;
  /** Display path for stubs (always the raw path arg when present). */
  pathArg?: string;
  /**
   * Dedup identity for re-read stubbing. Full-file reads share the path alone;
   * ranged reads (offset/limit) get a distinct key so chunked reads of the same
   * file do not hollow each other.
   */
  readKey?: string;
};

type PathRead = {
  callId: string;
  /** Monotonic order across the turn list; higher = later in the session. */
  order: number;
  isError: boolean;
};

function scalarArg(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value;
  return "";
}

/**
 * Extract path + re-read identity from a tool_call's arguments.
 * Identity is path alone for full-file reads; path+offset+limit when either
 * range arg is present so partial reads don't supersede each other.
 */
function readIdentityFromArguments(raw: unknown): { path: string; readKey: string } | undefined {
  let args: unknown = raw ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      return undefined;
    }
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const rec = args as Record<string, unknown>;
  const path = rec["path"];
  if (typeof path !== "string" || path.length === 0) return undefined;
  const offsetPart = scalarArg(rec["offset"]);
  const limitPart = scalarArg(rec["limit"]);
  const readKey =
    offsetPart === "" && limitPart === "" ? path : `${path}\0${offsetPart}\0${limitPart}`;
  return { path, readKey };
}

// Deterministic key for structurally equal arguments regardless of key order.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const entries = Object.keys(rec)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`);
    return `{${entries.join(",")}}`;
  }
  const scalar = JSON.stringify(value);
  return scalar === undefined ? "undefined" : scalar;
}

/**
 * Dedup identity for a query tool call: tool name + canonicalized arguments.
 * Only byte-identical (modulo key order) calls share a key, so a grep for a
 * different pattern or a list of a different directory never supersedes.
 */
function queryIdentityFromArguments(name: string, raw: unknown): string | undefined {
  let args: unknown = raw ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      return undefined;
    }
  }
  return `${name}\0${stableStringify(args)}`;
}

// callId → tool name/path for readable stubs. Inverse of path-to-reads.
function buildCallIndex(turns: readonly ConversationTurn[]): Map<string, ToolCallInfo> {
  const index = new Map<string, ToolCallInfo>();
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type !== "tool_call") continue;
      const info: ToolCallInfo = { name: block.name };
      const identity = readIdentityFromArguments(block.arguments);
      if (identity !== undefined) {
        info.pathArg = identity.path;
        info.readKey = identity.readKey;
      }
      if (QUERY_TOOLS.has(block.name)) {
        const queryKey = queryIdentityFromArguments(block.name, block.arguments);
        if (queryKey !== undefined) info.readKey = queryKey;
      }
      index.set(block.id, info);
    }
  }
  return index;
}

/**
 * Read-identity → every replayable read/query result that matched it, in
 * session order. Groups repeated full-file (or same-range) reads and repeated
 * identical query calls so older successful results can be stubbed when a
 * later identical call survives compaction.
 *
 * Callers must pass only turns that survive compaction (anchors + recent).
 * Computing supersession over the full transcript would hollow a kept older
 * read when the newer re-read was summarized away — leaving the model with a
 * stub and no full body.
 */
function buildPathToReads(
  turns: readonly ConversationTurn[],
  callIndex: ReadonlyMap<string, ToolCallInfo>,
): Map<string, PathRead[]> {
  const pathToReads = new Map<string, PathRead[]>();
  let order = 0;
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type !== "tool_result") continue;
      const info = callIndex.get(block.callId);
      if (info === undefined || !isReplayableResultTool(info.name) || info.readKey === undefined)
        continue;
      const entry: PathRead = {
        callId: block.callId,
        order: order++,
        isError: block.isError === true,
      };
      const list = pathToReads.get(info.readKey);
      if (list === undefined) pathToReads.set(info.readKey, [entry]);
      else list.push(entry);
    }
  }
  return pathToReads;
}

/**
 * Call ids of successful read/query results that are superseded by a later
 * successful call of the same identity (path or path+offset+limit for reads,
 * full canonical arguments for query tools). Error results never appear here —
 * they stay verbatim so the model still sees the failure.
 */
function supersededReadCallIds(pathToReads: ReadonlyMap<string, PathRead[]>): Set<string> {
  const superseded = new Set<string>();
  for (const reads of pathToReads.values()) {
    const successes = reads.filter((r) => !r.isError);
    if (successes.length < 2) continue;
    // Newest success (highest order) stays whole; every earlier success stubs.
    for (let i = 0; i < successes.length - 1; i++) {
      superseded.add(successes[i]!.callId);
    }
  }
  return superseded;
}

// Locate the turn index of each tool_call and its matching tool_result. In this
// runtime a call lives on one turn and its result on the following turn, so the
// two halves of a pair can straddle a keep/summarize boundary.
type PairLocation = { callIdx?: number; resultIdx?: number };
function buildPairIndex(turns: ConversationTurn[]): Map<string, PairLocation> {
  const pairs = new Map<string, PairLocation>();
  turns.forEach((turn, idx) => {
    for (const block of turn.content) {
      if (block.type === "tool_call") {
        const loc = pairs.get(block.id) ?? {};
        loc.callIdx = idx;
        pairs.set(block.id, loc);
      } else if (block.type === "tool_result") {
        const loc = pairs.get(block.callId) ?? {};
        loc.resultIdx = idx;
        pairs.set(block.callId, loc);
      }
    }
  });
  return pairs;
}

// Errored results score BELOW the anchor threshold on purpose: a lone failure
// is context for the summary, not an anchor. Scoring errors at or above the
// threshold preserved every iteration of a failing-edit retry loop verbatim
// past the summary boundary, crowding the kept context with the loop while
// the substance was summarized away. Two distinct errors on one turn still
// clear the threshold.
const ERRORED_RESULT_SCORE = 3;

// Whitespace-collapsed error-text prefix length compared when deciding two
// errored results are the same failure repeating. Long enough to separate
// distinct errors, short enough that trailing variable detail (line numbers,
// retry counters) does not defeat the collapse.
const ERROR_SIGNATURE_PREFIX_CHARS = 120;

type ToolResultBlock = Extract<ConversationTurn["content"][number], { type: "tool_result" }>;

function erroredResultSignature(
  block: ToolResultBlock,
  callIndex: ReadonlyMap<string, ToolCallInfo>,
): string {
  const info = callIndex.get(block.callId);
  const name = info === undefined ? "" : info.name;
  const text = block.content
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("")
    .replace(/\s+/g, " ")
    .slice(0, ERROR_SIGNATURE_PREFIX_CHARS);
  return `${name}\0${text}`;
}

/**
 * Call ids of errored results whose (tool name, error-text prefix) signature
 * recurs on a later turn in the same set. Every occurrence but the last is
 * returned, collapsing a retry loop's repeats to one representative — the
 * most recent failure, which is the state the agent must resume from.
 */
function repeatedErroredResultCallIds(
  turns: readonly ConversationTurn[],
  callIndex: ReadonlyMap<string, ToolCallInfo>,
): Set<string> {
  const lastSeen = new Map<string, string>();
  const repeated = new Set<string>();
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type !== "tool_result" || block.isError !== true) continue;
      const signature = erroredResultSignature(block, callIndex);
      const previous = lastSeen.get(signature);
      if (previous !== undefined) repeated.add(previous);
      lastSeen.set(signature, block.callId);
    }
  }
  return repeated;
}

// Score a turn by its anchor importance. Turns that write files or update
// tasks are load-bearing regardless of age. Errored results whose failure
// signature repeats later contribute nothing — only the last occurrence of a
// recurring error counts (see repeatedErroredResultCallIds).
function anchorScore(turn: ConversationTurn, suppressedErrorCallIds: ReadonlySet<string>): number {
  let score = 0;
  for (const block of turn.content) {
    if (block.type === "tool_call") {
      if (block.name === "edit_file" || block.name === "write_file") score += 10;
      else if (block.name === "manage_tasks") score += 7;
    }
    if (
      block.type === "tool_result" &&
      block.isError === true &&
      !suppressedErrorCallIds.has(block.callId)
    ) {
      score += ERRORED_RESULT_SCORE;
    }
  }
  return score;
}

// Turn index → pair-partner turn indices, derived from the pair index, so
// closure walks touch each pair once instead of rescanning all pairs per step.
function buildPartnerIndex(pairs: ReadonlyMap<string, PairLocation>): Map<number, number[]> {
  const partners = new Map<number, number[]>();
  const link = (a: number, b: number): void => {
    const list = partners.get(a);
    if (list === undefined) partners.set(a, [b]);
    else list.push(b);
  };
  for (const { callIdx, resultIdx } of pairs.values()) {
    if (callIdx === undefined || resultIdx === undefined || callIdx === resultIdx) continue;
    link(callIdx, resultIdx);
    link(resultIdx, callIdx);
  }
  return partners;
}

/**
 * Older-region turn indices a candidate anchor drags along: itself plus its
 * tool_call/tool_result partners, transitively, minus turns already kept
 * (recent window or previously anchored). Selecting anchors closure-at-a-time
 * is what lets maxAnchorTurns bound the total pull: a pair is either taken
 * whole or not at all, so no partner ever needs an over-budget rescue.
 */
function pairClosure(
  start: number,
  partnerIndex: ReadonlyMap<number, number[]>,
  keepFrom: number,
  kept: ReadonlySet<number>,
): Set<number> {
  const closure = new Set<number>();
  const queue = [start];
  while (queue.length > 0) {
    const idx = queue.pop();
    if (idx === undefined || idx >= keepFrom || kept.has(idx) || closure.has(idx)) continue;
    closure.add(idx);
    const partners = partnerIndex.get(idx);
    if (partners !== undefined) queue.push(...partners);
  }
  return closure;
}

function addPairClosure(
  start: number,
  partnerIndex: ReadonlyMap<number, number[]>,
  keepFrom: number,
  kept: Set<number>,
): void {
  for (const idx of pairClosure(start, partnerIndex, keepFrom, kept)) kept.add(idx);
}

// Index of the first turn carrying the user's own words. This is the
// initiating task; it must survive compaction so the agent never loses what
// it was asked to do, even when it falls far outside the recent window.
function firstUserTurnIndex(turns: ConversationTurn[]): number {
  return turns.findIndex((t) => t.role === "user" && t.content.some((b) => b.type === "text"));
}

function resultContentSize(
  block: Extract<ConversationTurn["content"][number], { type: "tool_result" }>,
): number {
  return block.content.reduce((sum, c) => sum + (c.type === "text" ? c.text.length : 0), 0);
}

function buildResultStub(
  block: Extract<ConversationTurn["content"][number], { type: "tool_result" }>,
  callIndex: ReadonlyMap<string, ToolCallInfo>,
): string {
  const info = callIndex.get(block.callId);
  const name = info?.name ?? "tool_result";
  const size = resultContentSize(block);
  if (info?.pathArg !== undefined) {
    const path = info.pathArg;
    const spillHint = path.startsWith("tool-output://")
      ? " Re-read with read_file offset/limit or grep on that URI."
      : "";
    return `[${name} ${path} — ${size} chars omitted from context; source unchanged.${spillHint}]`;
  }
  return `[${name} — ${size} chars, omitted]`;
}

// Hollow out superseded successful read_file results; leave everything else.
// Errors and the newest successful read of each path stay whole.
function stubSupersededReads(
  turn: ConversationTurn,
  superseded: ReadonlySet<string>,
  callIndex: ReadonlyMap<string, ToolCallInfo>,
): ConversationTurn {
  if (superseded.size === 0) return turn;
  let changed = false;
  const content = turn.content.map((block): ConversationTurn["content"][number] => {
    if (block.type !== "tool_result" || !superseded.has(block.callId)) return block;
    // Defensive: errors never enter the superseded set, but keep them whole.
    if (block.isError === true) return block;
    changed = true;
    return { ...block, content: [{ type: "text", text: buildResultStub(block, callIndex) }] };
  });
  return changed ? { ...turn, content } : turn;
}

// True when a turn carries no tool_call/tool_result blocks.
function isPlainTextTurn(turn: ConversationTurn): boolean {
  return !turn.content.some((b) => b.type === "tool_call" || b.type === "tool_result");
}

/**
 * Age base64 images in every turn outside the recent window into rehydratable
 * attachment:// markers + StrategyBlob spills. Runs even when full pruning is
 * not needed so pastes stop being resent as soon as they leave the window.
 */
async function ageImagesOutsideRecentWindow(
  turns: ConversationTurn[],
  keepRecentTurns: number,
): Promise<{ turns: ConversationTurn[]; blobs: StrategyBlob[]; agedImageCount: number }> {
  if (turns.length === 0) {
    return { turns, blobs: [], agedImageCount: 0 };
  }
  const keepCount = Math.min(keepRecentTurns, turns.length);
  const keepFrom = turns.length - keepCount;

  // Fast path: nothing outside the recent window needs aging.
  let needsAge = false;
  for (let i = 0; i < keepFrom; i++) {
    if (turns[i]!.content.some((b) => b.type === "image")) {
      needsAge = true;
      break;
    }
  }
  if (!needsAge) {
    return { turns, blobs: [], agedImageCount: 0 };
  }

  const blobs: StrategyBlob[] = [];
  let agedImageCount = 0;
  const out: ConversationTurn[] = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    if (i < keepFrom && turn.content.some((b) => b.type === "image")) {
      const aged = await ageImageBlocks(turn);
      out.push(aged.turn);
      blobs.push(...aged.blobs);
      agedImageCount += aged.blobs.length;
    } else {
      out.push(turn);
    }
  }

  return { turns: out, blobs, agedImageCount };
}

// Merge each adjacent same-role turn whose later half is plain text into the
// turn before it. Pulling anchors out of the middle of the history and
// prepending the summary turn can place two same-role turns next to each
// other, which the Anthropic Messages API rejects.
//
// Given well-formed alternating input, every same-role adjacency compaction
// itself introduces has a plain-text later turn — the pairing pass keeps each
// tool_result next to its tool_call, so tool-bearing turns stay alternating —
// so this removes all of them. It does not repair a non-alternating sequence
// that was already present in the input.
//
// Only the later turn must be plain text; the earlier one may carry a
// tool_result. A surviving tool_result is always immediately preceded by its
// assistant tool_call, never by a text turn, so it only ever merges as the
// first block of the combined turn — its position relative to its tool_call is
// preserved, and no tool_call/tool_result sequence is disturbed.
function coalesceAdjacentTextTurns(turns: ConversationTurn[]): ConversationTurn[] {
  const out: ConversationTurn[] = [];
  for (const turn of turns) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.role === turn.role && isPlainTextTurn(turn)) {
      out[out.length - 1] = { ...prev, content: [...prev.content, ...turn.content] };
    } else {
      out.push(turn);
    }
  }
  return out;
}

export function createPruningCompactor(config: Partial<CompactorConfig> = {}): Compactor {
  const cfg = { ...DEFAULT_COMPACTOR_CONFIG, ...config };

  return {
    name: "pruning-compactor",
    version: "1.4.0",
    async apply(
      turns: ConversationTurn[],
      _ctx: StrategyContext,
    ): Promise<StrategyResult<ConversationTurn[]>> {
      // Eager image aging runs before the compact/no-op branch so base64 pastes
      // leave the inference-facing context as soon as they exit the recent window.
      const aged = await ageImagesOutsideRecentWindow(turns, cfg.keepRecentTurns);

      if (aged.turns.length <= compactorNoOpFloor(cfg.keepRecentTurns)) {
        return {
          output: aged.turns,
          record: {
            strategy: this.name,
            version: this.version,
            parameters: { keepRecentTurns: cfg.keepRecentTurns },
            reason:
              aged.agedImageCount > 0
                ? "aged images outside recent window"
                : "no compaction needed",
            decisions: { agedImageCount: aged.agedImageCount },
          },
          ...(aged.blobs.length > 0 ? { blobs: aged.blobs } : {}),
        };
      }

      // callId → name/path for stubs. Built over the full transcript so a kept
      // result can still name its path even when its call turn was summarized.
      const callIndex = buildCallIndex(aged.turns);

      const keepCount = Math.min(cfg.keepRecentTurns, aged.turns.length - 1);
      const keepFrom = aged.turns.length - keepCount;
      const recentTurns = aged.turns.slice(keepFrom);
      const olderTurns = aged.turns.slice(0, keepFrom);

      const pairs = buildPairIndex(aged.turns);
      const partnerIndex = buildPartnerIndex(pairs);

      // Repeated identical errors collapse to their last occurrence before
      // scoring, so a failing retry loop contributes one representative
      // instead of scoring every iteration.
      const repeatedErrors = repeatedErroredResultCallIds(olderTurns, callIndex);
      const scoredOlder = olderTurns.map((t, i) => ({
        index: i,
        score: anchorScore(t, repeatedErrors),
      }));

      // Keep tool_call/tool_result pairs together across the keep/summarize
      // boundary: a surviving turn whose partner is summarized leaves a
      // dangling tool_call or an orphaned tool_result, which the inference
      // layer rejects. Partners of recent-window turns are mandatory pulls
      // and are counted against maxAnchorTurns first, so the cap bounds the
      // total turns pulled forward past the summary.
      const anchorIndices = new Set<number>();
      for (const { callIdx, resultIdx } of pairs.values()) {
        if (callIdx === undefined || resultIdx === undefined) continue;
        if (callIdx >= keepFrom && resultIdx < keepFrom)
          addPairClosure(resultIdx, partnerIndex, keepFrom, anchorIndices);
        else if (resultIdx >= keepFrom && callIdx < keepFrom)
          addPairClosure(callIdx, partnerIndex, keepFrom, anchorIndices);
      }

      // Pull high-importance turns forward regardless of age, most recent
      // first so the freshest anchors survive. Each candidate is taken with
      // its pair partners, whole closure or not at all, and only while the
      // combined pull stays within maxAnchorTurns.
      let anchorBudget = Math.max(0, cfg.maxAnchorTurns - anchorIndices.size);
      for (let i = scoredOlder.length - 1; i >= 0; i--) {
        const candidate = scoredOlder[i];
        if (candidate === undefined) continue;
        if (candidate.score < ANCHOR_SCORE_THRESHOLD || anchorIndices.has(candidate.index))
          continue;
        const closure = pairClosure(candidate.index, partnerIndex, keepFrom, anchorIndices);
        if (closure.size > anchorBudget) continue;
        for (const idx of closure) anchorIndices.add(idx);
        anchorBudget -= closure.size;
      }

      // Always keep the initiating task verbatim, outside the maxAnchorTurns
      // cap. Losing the oldest user turn is how the agent forgets what it was
      // asked to do; correctness outranks the size target here.
      const initiatingIdx = firstUserTurnIndex(olderTurns);
      if (initiatingIdx >= 0) addPairClosure(initiatingIdx, partnerIndex, keepFrom, anchorIndices);

      // Ascending original order keeps the concatenated [anchors, recent]
      // sequence globally index-ordered, so every result still follows its call.
      const sortedAnchorIndices = [...anchorIndices].sort((a, b) => a - b);
      const anchorTurns = sortedAnchorIndices.map((i) => olderTurns[i]!);
      const summarizedTurns = olderTurns.filter((_, i) => !anchorIndices.has(i));

      // Path-dedup only among turns that survive. Supersession over the full
      // transcript would hollow a kept older read when the newer re-read is only
      // in the summary (CL-4374 review follow-up).
      const pathToReads = buildPathToReads([...anchorTurns, ...recentTurns], callIndex);
      const supersededReads = supersededReadCallIds(pathToReads);

      const summary =
        cfg.summarize !== undefined
          ? await cfg.summarize(summarizedTurns, cfg.summaryContext?.())
          : buildTurnSummary(summarizedTurns, cfg.summaryMaxChars, anchorTurns.length);

      // A user-role turn survives every adapter unchanged. A system-role turn
      // does not: the Anthropic builder drops mid-conversation system turns
      // whenever a system-prompt override is set, and the Grok builder emits
      // them as a stray mid-stream system message. Framing the summary as user
      // content keeps it in the conversation on every provider.
      const summaryTurn: ConversationTurn = {
        role: "user",
        content: [{ type: "text", text: `[Compacted prior context]\n${summary}` }],
        timestamp: olderTurns[olderTurns.length - 1]?.timestamp ?? Date.now(),
      };

      // Anchors and recent turns stay contentful except for path-dedup: when the
      // same file was read successfully more than once among kept turns, older
      // results become a one-line stub and the newest stays whole. Error results
      // are never stubbed. SummarizedTurns lose content wholesale via the summary
      // above. Anchors are already image-aged (outside the recent window). Recent
      // turns keep live base64 so a just-pasted screenshot still reaches the model.
      const process = (t: ConversationTurn): ConversationTurn =>
        stubSupersededReads(t, supersededReads, callIndex);
      const output = coalesceAdjacentTextTurns([
        summaryTurn,
        ...anchorTurns.map(process),
        ...recentTurns.map(process),
      ]);

      return {
        output,
        record: {
          strategy: this.name,
          version: this.version,
          parameters: {
            keepRecentTurns: cfg.keepRecentTurns,
            summaryMaxChars: cfg.summaryMaxChars,
            maxAnchorTurns: cfg.maxAnchorTurns,
          },
          reason: `compacted ${summarizedTurns.length} turns, anchored ${anchorTurns.length}, keeping ${keepCount} recent`,
          decisions: {
            summarizedTurnCount: summarizedTurns.length,
            anchorTurnCount: anchorTurns.length,
            recentTurnCount: recentTurns.length,
            summaryLength: summary.length,
            agedImageCount: aged.agedImageCount,
            supersededReadCount: supersededReads.size,
            repeatedErrorCount: repeatedErrors.size,
          },
        },
        ...(aged.blobs.length > 0 ? { blobs: aged.blobs } : {}),
      };
    },
  };
}

export function buildTurnSummary(
  turns: ConversationTurn[],
  maxChars: number,
  anchorCount = 0,
): string {
  const toolNames = new Set<string>();
  let totalTokens = 0;
  let lastUserMessage = "";
  let toolCallCount = 0;

  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type === "text") {
        totalTokens += Math.ceil(block.text.length / 4);
      }
      if (block.type === "tool_call") {
        toolNames.add(block.name);
        toolCallCount++;
        totalTokens += Math.ceil(JSON.stringify(block.arguments).length / 4);
      }
      if (block.type === "tool_result") {
        totalTokens += Math.ceil(resultContentSize(block) / 4);
      }
    }
    if (turn.role === "user") {
      const textBlock = turn.content.find((b) => b.type === "text");
      if (textBlock !== undefined) lastUserMessage = textBlock.text.slice(0, 200);
    }
  }

  const lines: string[] = [
    `Turns compacted: ${turns.length}${anchorCount > 0 ? ` (${anchorCount} anchor turns preserved separately)` : ""}`,
    `Estimated tokens: ~${totalTokens}`,
    `Tools called: ${[...toolNames].sort().join(", ")}`,
    `Total tool calls: ${toolCallCount}`,
  ];

  if (lastUserMessage.length > 0) {
    lines.push(`Last user message: "${lastUserMessage}"`);
  }

  const summary = lines.join("\n");
  return summary.length > maxChars ? summary.slice(0, maxChars - 3) + "..." : summary;
}

/**
 * Build an LLM-generated structured summary of a sequence of turns.
 *
 * Calls `summarize` with a condensed representation of the turns and returns
 * the result string directly. Falls back to `buildTurnSummary` if the
 * summarize call fails.
 */
export async function buildLLMTurnSummary(
  turns: ConversationTurn[],
  summarize: (prompt: string) => Promise<string>,
  maxChars = 3000,
): Promise<string> {
  // Build a condensed input representation for the LLM
  const toolNames = new Set<string>();
  let lastUserMessage = "";
  const assistantSnippets: string[] = [];

  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type === "tool_call") {
        toolNames.add(block.name);
      }
    }
    if (turn.role === "user") {
      const textBlock = turn.content.find((b) => b.type === "text");
      if (textBlock !== undefined && textBlock.type === "text") {
        lastUserMessage = textBlock.text.slice(0, 300);
      }
    }
    if (turn.role === "assistant") {
      const textBlock = turn.content.find((b) => b.type === "text");
      if (textBlock !== undefined && textBlock.type === "text" && textBlock.text.length > 0) {
        assistantSnippets.push(textBlock.text.slice(0, 200));
      }
    }
  }

  const condensed = [
    `Turns: ${turns.length}`,
    `Tools called: ${[...toolNames].sort().join(", ")}`,
    lastUserMessage.length > 0 ? `Last user message: "${lastUserMessage}"` : null,
    assistantSnippets.length > 0
      ? `Assistant messages (excerpts):\n${assistantSnippets.slice(-3).join("\n---\n")}`
      : null,
  ]
    .filter((l) => l !== null)
    .join("\n")
    .slice(0, 2000);

  const prompt = [
    "You are summarizing a completed coding session for context compaction.",
    "Based on the session excerpt below, produce a structured summary in exactly this format:",
    "",
    "Goal: <what the user was trying to accomplish>",
    "Constraints: <any constraints or requirements mentioned>",
    "Progress: <what was done and what worked>",
    "Key Decisions: <important decisions made>",
    "Next Steps: <what was left or planned next>",
    "Critical Context: <anything the next task needs to know>",
    "",
    "Session excerpt:",
    condensed,
  ].join("\n");

  try {
    const text = await summarize(prompt);
    return text.slice(0, maxChars);
  } catch {
    return buildTurnSummary(turns, maxChars);
  }
}

/**
 * Build the current-plan text from a plan steps array.
 */
export function formatPlan(
  steps: Array<{ file: string; action: string; reason?: string }>,
): string {
  return steps
    .map((s, i) => `${i + 1}. ${s.file} — ${s.action}${s.reason ? ` (${s.reason})` : ""}`)
    .join("\n");
}
