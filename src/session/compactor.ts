// Context curation and compaction for the perpetual session.
//
// Deterministic ConversationTurn[] -> ConversationTurn[] compactor: prunes
// completed-task context while preserving the active task, recent turns, plan
// state, file/tool references, and unresolved errors.
//
// The context store keeps the full run history; only the inference-facing
// context is curated here.

import type {
  ConversationTurn,
  Compactor,
  StrategyContext,
  StrategyResult,
  StrategyBlob,
} from "@intx/types/runtime";
import { ageImageBlocks } from "./attachment-store.js";
import { buildHandoffFold, COMPACTED_PREFIX } from "./compaction-handoff.js";
import {
  classifySummarizerFailure,
  type SummarizerFailureClass,
  type SummaryContext,
} from "./summarizer.js";
import {
  extractContinuationFacts,
  verifyOrRepair,
} from "./compaction-verify.js";
import { canonicalToolName } from "../agent/canonical-tool-name.js";
import {
  PATH_KEYED_READ_TOOLS,
  SEARCH_QUERY_TOOLS,
} from "../agent/tool-classification.js";
import {
  estimateContentBlockTokens,
  estimateContextTokens,
} from "../agent/context-estimate.js";
import { THINKING_ONLY_OMITTED } from "../provider/replay-sanitizer.js";

// ---------------------------------------------------------------------------
// Compactor
// ---------------------------------------------------------------------------

export interface CompactorConfig {
  summaryMaxChars: number;
  summarize?: (
    turns: ConversationTurn[],
    ctx?: SummaryContext,
  ) => Promise<string>;
  /** Read at compaction time; passed to `summarize` with live workflow state. */
  summaryContext?: () => SummaryContext | undefined;
  /** Previous fat handoff body, so the next fold unions files/commands and full constraint/goal text instead of spine-truncated cuts. */
  readPriorHandoff?: () => Promise<string | undefined>;
  // Recorded for compatibility; the live fold keeps spine + token-capped tail.
  maxAnchorTurns: number;
  /** Budgeted-tail shape (token budget, not turn-count floor). Partial: missing fields resolve against DEFAULT_TAIL_COMPACTION_SHAPE. */
  compactionShape?: Partial<CompactionShape>;
}

/**
 * Shape of the live tail the fold keeps: extract + summary + actions (thin
 * spine / fat handoff file) plus a token-capped raw tail (~2–3k tokens by
 * default). The governor reads the resolved copy off record.parameters.
 */
export interface CompactionShape {
  /** Live-tail budget in tokens (chars/4 estimate). Default ~2500. */
  tailBudgetTokens: number;
  /** Tool outputs in the tail longer than this are head+tail excerpted. */
  maxTailToolOutputChars: number;
  /** Keep the head of a shortened tail tool output. */
  excerptHead: boolean;
  /** Keep the tail of a shortened tail tool output. */
  excerptTail: boolean;
  /** Newest user messages (plus attachments) stay whole up to the budget. */
  preserveWholeUserMessages: boolean;
  /** Cut points never split a tool call from its result (whole-or-nothing). */
  pairSafe: boolean;
}

export const DEFAULT_TAIL_COMPACTION_SHAPE: CompactionShape = {
  tailBudgetTokens: 2500,
  maxTailToolOutputChars: 2048,
  excerptHead: true,
  excerptTail: true,
  preserveWholeUserMessages: true,
  pairSafe: true,
};

export function resolveCompactionShape(
  partial?: Partial<CompactionShape>,
): CompactionShape {
  return { ...DEFAULT_TAIL_COMPACTION_SHAPE, ...partial };
}

// Fold marker; the handoff format is owned by ./compaction-handoff.js.
// Re-exported here so existing importers keep working.
export { COMPACTED_PREFIX };

// Visible, non-format sentinel inserted between adjacent user turns so the
// history stays role-alternating and adapters keep a non-empty assistant
// turn. Identity is the reserved producer id on `compactSpacerTurn`, not this
// text or a missing `model` field.
export const COMPACT_SPACER_TEXT = "[compact]";
export const LEGACY_COMPACT_SPACER_TEXT = "[compaction]";
export const HARNESS_COMPACT_SPACER_MODEL = "harness";

const DEFAULT_COMPACTOR_CONFIG: CompactorConfig = {
  summaryMaxChars: 2000,
  maxAnchorTurns: 8,
};

function extraInstructionParameter(
  cfg: CompactorConfig,
): { extraInstructions: string } | Record<string, never> {
  const extra = cfg.summaryContext?.()?.extraInstructions?.trim();
  if (extra === undefined || extra.length === 0) return {};
  return { extraInstructions: extra };
}

// `apply` no-ops at or below this turn count: a single turn cannot shrink.
export function compactorNoOpFloor(): number {
  return 1;
}

// Query tools deduped by full-argument identity: a later identical
// grep/search_files/list_dir call reflects newer workspace state, so older
// identical results are stale. run_shell is excluded — the same command is
// not idempotent, so an older result can be the only record of a genuinely
// distinct outcome.
const QUERY_TOOLS = new Set([...SEARCH_QUERY_TOOLS, "list_dir"]);

function isReplayableResultTool(name: string): boolean {
  return PATH_KEYED_READ_TOOLS.has(name) || QUERY_TOOLS.has(name);
}

// Call-id index for stub rendering (name + path). Dedup keys live on `readKey`.
interface ToolCallInfo {
  name: string;
  /** Display path for stubs (always the raw path arg when present). */
  pathArg?: string;
  /** Dedup identity for re-read stubbing. Full-file reads share the path; ranged reads (offset/limit) get a distinct key so chunked reads of one file do not hollow each other. */
  readKey?: string;
}

interface PathRead {
  callId: string;
  /** Monotonic order across the turn list; higher = later in the session. */
  order: number;
  isError: boolean;
}

function scalarArg(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value;
  return "";
}

/** Path + re-read identity from a tool_call's arguments: path alone for full-file reads; path+offset+limit when either range arg is present so partial reads don't supersede each other. */
function readIdentityFromArguments(
  raw: unknown,
): { path: string; readKey: string } | undefined {
  let args: unknown = raw ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      return undefined;
    }
  }
  if (args === null || typeof args !== "object" || Array.isArray(args))
    return undefined;
  const rec = args as Record<string, unknown>;
  const path = rec["path"];
  if (typeof path !== "string" || path.length === 0) return undefined;
  const offsetPart = scalarArg(rec["offset"]);
  const limitPart = scalarArg(rec["limit"]);
  const readKey =
    offsetPart === "" && limitPart === ""
      ? path
      : `${path}\0${offsetPart}\0${limitPart}`;
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

/** Dedup identity for a query call: tool name + canonicalized arguments. Only byte-identical (modulo key order) calls share a key, so differing calls never supersede each other. */
function queryIdentityFromArguments(
  name: string,
  raw: unknown,
): string | undefined {
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
function buildCallIndex(
  turns: readonly ConversationTurn[],
): Map<string, ToolCallInfo> {
  const index = new Map<string, ToolCallInfo>();
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type !== "tool_call") continue;
      // Persisted calls keep the name the model emitted on the wire
      // (read/glob/…); the read/query classification sets are engine-keyed.
      const info: ToolCallInfo = { name: canonicalToolName(block.name) };
      const identity = readIdentityFromArguments(block.arguments);
      if (identity !== undefined) {
        info.pathArg = identity.path;
        info.readKey = identity.readKey;
      }
      if (QUERY_TOOLS.has(block.name)) {
        const queryKey = queryIdentityFromArguments(
          block.name,
          block.arguments,
        );
        if (queryKey !== undefined) info.readKey = queryKey;
      }
      index.set(block.id, info);
    }
  }
  return index;
}

/**
 * Read-identity → matching replayable read/query results in session order.
 *
 * Callers pass only turns that survive compaction: supersession over the full
 * transcript would hollow a kept older read when the newer re-read was
 * summarized away.
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
      if (
        info === undefined ||
        !isReplayableResultTool(info.name) ||
        info.readKey === undefined
      )
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
 * Call ids of successful results superseded by a later successful call of the
 * same identity. Error results never appear — they stay verbatim so the model
 * still sees the failure.
 */
function supersededReadCallIds(
  pathToReads: ReadonlyMap<string, PathRead[]>,
): Set<string> {
  const superseded = new Set<string>();
  for (const reads of pathToReads.values()) {
    const successes = reads.filter((r) => !r.isError);
    if (successes.length < 2) continue;
    // Newest success (highest order) stays whole; every earlier success stubs.
    for (const read of successes.slice(0, -1)) {
      superseded.add(read.callId);
    }
  }
  return superseded;
}

// Turn index of each tool_call and its matching tool_result. A call lives on
// one turn and its result on the next, so a pair can straddle a
// keep/summarize boundary.
interface PairLocation {
  callIdx?: number;
  resultIdx?: number;
}
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

// Whitespace-collapsed error-text prefix length compared when deciding two
// errored results are the same failure repeating. Long enough to separate
// distinct errors, short enough that trailing variable detail (line numbers,
// retry counters) does not defeat the collapse.
const ERROR_SIGNATURE_PREFIX_CHARS = 120;

type ToolResultBlock = Extract<
  ConversationTurn["content"][number],
  { type: "tool_result" }
>;

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
 * Call ids of errored results whose (name, error-text prefix) signature
 * recurs on a later turn. Every occurrence but the last is returned,
 * collapsing a retry loop to its most recent failure.
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

// Turn index → pair-partner turn indices, so closure walks touch each pair
// once instead of rescanning all pairs per step.
function buildPartnerIndex(
  pairs: ReadonlyMap<string, PairLocation>,
): Map<number, number[]> {
  const partners = new Map<number, number[]>();
  const link = (a: number, b: number): void => {
    const list = partners.get(a);
    if (list === undefined) partners.set(a, [b]);
    else list.push(b);
  };
  for (const { callIdx, resultIdx } of pairs.values()) {
    if (
      callIdx === undefined ||
      resultIdx === undefined ||
      callIdx === resultIdx
    )
      continue;
    link(callIdx, resultIdx);
    link(resultIdx, callIdx);
  }
  return partners;
}

function isFoldableHandoffTurn(turn: ConversationTurn): boolean {
  return isCompactedSummaryTurn(turn) || isCompactSpacerTurn(turn);
}

function resultContentSize(
  block: Extract<ConversationTurn["content"][number], { type: "tool_result" }>,
): number {
  return block.content.reduce(
    (sum, c) => sum + (c.type === "text" ? c.text.length : 0),
    0,
  );
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

// Hollow out superseded successful read_file results; errors and the newest
// success per path stay whole.
function stubSupersededReads(
  turn: ConversationTurn,
  superseded: ReadonlySet<string>,
  callIndex: ReadonlyMap<string, ToolCallInfo>,
): ConversationTurn {
  if (superseded.size === 0) return turn;
  let changed = false;
  const content = turn.content.map(
    (block): ConversationTurn["content"][number] => {
      if (block.type !== "tool_result" || !superseded.has(block.callId))
        return block;
      // Defensive: errors never enter the superseded set, but keep them whole.
      if (block.isError === true) return block;
      changed = true;
      return {
        ...block,
        content: [{ type: "text", text: buildResultStub(block, callIndex) }],
      };
    },
  );
  return changed ? { ...turn, content } : turn;
}

// True when a turn carries no tool_call/tool_result blocks.
function isPlainTextTurn(turn: ConversationTurn): boolean {
  return !turn.content.some(
    (b) => b.type === "tool_call" || b.type === "tool_result",
  );
}

/**
 * Age base64 images in every turn outside the budgeted tail into rehydratable
 * attachment:// markers + StrategyBlob spills. Tail turns keep live bytes so a
 * just-pasted screenshot still reaches the model.
 */
async function ageImagesOutsidePicked(
  turns: ConversationTurn[],
  picked: ReadonlySet<number>,
): Promise<{
  turns: ConversationTurn[];
  blobs: StrategyBlob[];
  agedImageCount: number;
}> {
  if (turns.length === 0) {
    return { turns, blobs: [], agedImageCount: 0 };
  }

  let needsAge = false;
  for (let i = 0; i < turns.length; i++) {
    if (picked.has(i)) continue;
    const turn = turns[i];
    if (turn !== undefined && turn.content.some((b) => b.type === "image")) {
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
    const turn = turns[i];
    if (turn === undefined) continue;
    if (!picked.has(i) && turn.content.some((b) => b.type === "image")) {
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
// turn before it: compaction can leave same-role neighbors, which the
// Anthropic Messages API rejects. A turn carrying a tool_result never fuses —
// result bodies are bulk the tail budgets per turn, and a hybrid turn could
// not be budgeted independently. Call headers stay fusible; a surviving
// result still lands right after its tool_call, so no call/result sequence
// is disturbed. Result/text neighbors that no longer fuse get a [compact]
// spacer from separateAdjacentUserTurns.
function carriesToolResult(turn: ConversationTurn): boolean {
  return turn.content.some((block) => block.type === "tool_result");
}

function coalesceAdjacentTextTurns(
  turns: ConversationTurn[],
): ConversationTurn[] {
  const out: ConversationTurn[] = [];
  for (const turn of turns) {
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      prev.role === turn.role &&
      !carriesToolResult(prev) &&
      isPlainTextTurn(turn) &&
      !isCompactedSummaryTurn(prev) &&
      !isCompactedSummaryTurn(turn) &&
      !isCompactSpacerTurn(prev) &&
      !isCompactSpacerTurn(turn)
    ) {
      out[out.length - 1] = {
        ...prev,
        content: [...prev.content, ...turn.content],
      };
    } else {
      out.push(turn);
    }
  }
  return out;
}

function separateAdjacentUserTurns(
  turns: ConversationTurn[],
): ConversationTurn[] {
  const out: ConversationTurn[] = [];
  for (const turn of turns) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.role === "user" && turn.role === "user") {
      out.push(compactSpacerTurn(turn.timestamp));
    }
    out.push(turn);
  }
  return out;
}

function firstTextBlock(turn: ConversationTurn): string | undefined {
  for (const block of turn.content) {
    if (block.type === "text") return block.text;
  }
  return undefined;
}

function joinedTextBlocks(turn: ConversationTurn): string {
  let out = "";
  for (const block of turn.content) {
    if (block.type === "text") out += block.text;
  }
  return out;
}

function isCompactSpacerSentinel(text: string): boolean {
  return text === COMPACT_SPACER_TEXT || text === LEGACY_COMPACT_SPACER_TEXT;
}

export function assistantTextIsCompactSpacerEcho(text: string): boolean {
  return isCompactSpacerSentinel(text.trim());
}

export function isCompactSpacerEchoTurn(turn: ConversationTurn): boolean {
  for (const block of turn.content) {
    if (block.type === "tool_call") return false;
  }
  return assistantTextIsCompactSpacerEcho(joinedTextBlocks(turn));
}

function isCompactedSummaryTurn(turn: ConversationTurn): boolean {
  if (turn.role !== "user") return false;
  const text = firstTextBlock(turn);
  return text !== undefined && text.startsWith(COMPACTED_PREFIX);
}

// Harness spacers stamp `model: "harness"`. Missing `model` is unattributed
// (replay sanitizer), except persisted `[compaction]` spacers from before
// producer-id stamping. Model-produced copies carry a real model id and must
// not enter the frozen prefix.
export function isHarnessCompactSpacer(turn: ConversationTurn): boolean {
  if (turn.role !== "assistant") return false;
  const text = firstTextBlock(turn);
  if (text === undefined || !isCompactSpacerSentinel(text)) return false;
  if (turn.model === HARNESS_COMPACT_SPACER_MODEL) return true;
  return turn.model === undefined && text === LEGACY_COMPACT_SPACER_TEXT;
}

function isCompactSpacerTurn(turn: ConversationTurn): boolean {
  return isHarnessCompactSpacer(turn);
}

function compactSpacerTurn(timestamp: number): ConversationTurn {
  return {
    role: "assistant",
    content: [{ type: "text", text: COMPACT_SPACER_TEXT }],
    timestamp,
    model: HARNESS_COMPACT_SPACER_MODEL,
  };
}

// ---------------------------------------------------------------------------
// Budgeted tail
// ---------------------------------------------------------------------------

// Marker stamped by excerptTailText. Excerpting is idempotent: a live excerpt
// rides unchanged into the next fold. Matching the stamped marker, not a raw
// prefix, keeps a body that happens to mention the substring excerpted.
const TAIL_EXCERPT_SENTINEL = "[tail-shortened ";
const TAIL_EXCERPT_MARKER = /\[tail-shortened \d+→/;

// Shorten one oversized text part of a tail tool result to a head+tail
// excerpt. The sentinel and lengths make the loss visible; the full text
// stays stored and is never rewritten.
function excerptTailText(
  text: string,
  shape: CompactionShape,
): { text: string; shortened: boolean } {
  if (
    text.length <= shape.maxTailToolOutputChars ||
    TAIL_EXCERPT_MARKER.test(text)
  )
    return { text, shortened: false };
  const headChars = shape.excerptHead
    ? Math.ceil(shape.maxTailToolOutputChars / 2)
    : shape.maxTailToolOutputChars;
  const tailChars = shape.excerptTail
    ? Math.floor(shape.maxTailToolOutputChars / 2)
    : 0;
  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(text.length - tailChars) : "";
  return {
    text:
      `${head}\n${TAIL_EXCERPT_SENTINEL}${text.length}→${head.length + tail.length} chars; ` +
      `full text remains in the archived transcript]` +
      (tail.length > 0 ? `\n${tail}` : ""),
    shortened: true,
  };
}

// Excerpted live copy of a tail turn: thinking/redacted_thinking drop except
// on the last assistant that still has a tool_call (Anthropic continuation
// needs the unmodified thinking+signature on that tool_use). Whole blocks
// drop so signatures never ship with truncated text. Large tool_result text
// parts shrink to head+tail excerpts; user text, attachments, tool calls,
// and error results pass whole (errors are resume state, not bulk).
function excerptTailTurn(
  turn: ConversationTurn,
  shape: CompactionShape,
  keepThinking = false,
): { turn: ConversationTurn; shortenedOutputs: number; changed: boolean } {
  let shortenedOutputs = 0;
  let changed = false;
  const content = turn.content.flatMap((block): ConversationTurn["content"] => {
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      if (keepThinking) return [block];
      changed = true;
      return [];
    }
    if (block.type !== "tool_result" || block.isError === true) return [block];
    let blockChanged = false;
    const parts = block.content.map((c) => {
      if (c.type !== "text") return c;
      const excerpted = excerptTailText(c.text, shape);
      if (!excerpted.shortened) return c;
      shortenedOutputs += 1;
      blockChanged = true;
      changed = true;
      return { ...c, text: excerpted.text };
    });
    return [blockChanged ? { ...block, content: parts } : block];
  });
  // Dropping thinking/redacted_thinking can leave a thinking-only assistant
  // with empty content. Adapters 400 on that; keep the turn (role
  // alternation) and reuse the replay-sanitizer marker.
  const liveContent =
    content.length === 0
      ? [{ type: "text" as const, text: THINKING_ONLY_OMITTED }]
      : content;
  return {
    turn: changed ? { ...turn, content: liveContent } : turn,
    shortenedOutputs,
    changed,
  };
}

interface TailSelection {
  /** Indices actually selected for the live tail — not a contiguous slice. */
  picked: Set<number>;
  /** Excerpted live copies for tail turns that needed shortening. */
  excerpted: Map<number, ConversationTurn>;
  shortenedToolOutputs: number;
  /** Token estimate over the emitted (excerpted) tail. */
  tailTokenEstimate: number;
}

function lastAssistantToolCallIndex(
  turns: readonly ConversationTurn[],
): number | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn === undefined || turn.role !== "assistant") continue;
    return turn.content.some((block) => block.type === "tool_call")
      ? i
      : undefined;
  }
  return undefined;
}

function excerptedTurnTokens(
  turn: ConversationTurn,
  shape: CompactionShape,
  keepThinking = false,
): number {
  const { turn: live } = excerptTailTurn(turn, shape, keepThinking);
  let tokens = 0;
  for (const block of live.content) {
    tokens += estimateContentBlockTokens(block);
  }
  return tokens;
}

function isInteriorPairGap(
  idx: number,
  partnerIndex: ReadonlyMap<number, number[]>,
): boolean {
  for (const [a, partners] of partnerIndex) {
    for (const b of partners) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (idx > lo && idx < hi) return true;
    }
  }
  return false;
}

function isUserAskTurn(turn: ConversationTurn): boolean {
  return (
    turn.role === "user" &&
    !turn.content.some((b) => b.type === "tool_result") &&
    !isFoldableHandoffTurn(turn)
  );
}

// Newest→oldest budgeted tail: take whole call/result pairs until the token
// budget, excerpt oversized tool outputs, then stop. Unpicked gap turns
// between a dragged pair partner and the newest pick stay out. The newest
// pair is kept even over budget so the live prompt never lacks resume state.
// With preserveWholeUserMessages, the newest operator ask is paid first.
function selectTail(
  turns: readonly ConversationTurn[],
  shape: CompactionShape,
  partnerIndex: ReadonlyMap<number, number[]>,
): TailSelection {
  const n = turns.length;
  const excerpted = new Map<number, ConversationTurn>();
  const picked = new Set<number>();
  let shortenedToolOutputs = 0;
  let usedTokens = 0;
  const budgetTokens = shape.tailBudgetTokens;
  const keepThinkingAt = lastAssistantToolCallIndex(turns);

  const turnCost = (idx: number): { tokens: number; shortened: number } => {
    const turn = turns[idx];
    if (turn === undefined) return { tokens: 0, shortened: 0 };
    const keepThinking = idx === keepThinkingAt;
    const {
      turn: live,
      shortenedOutputs,
      changed,
    } = excerptTailTurn(turn, shape, keepThinking);
    if (changed) excerpted.set(idx, live);
    return {
      tokens: excerptedTurnTokens(turn, shape, keepThinking),
      shortened: shortenedOutputs,
    };
  };

  const pick = (idx: number): void => {
    if (picked.has(idx)) return;
    const turn = turns[idx];
    // A dragged pair partner that is a foldable handoff turn stays out of the
    // tail — it folds with the summarized region instead of riding live.
    if (turn === undefined || isFoldableHandoffTurn(turn)) return;
    picked.add(idx);
    const { tokens, shortened } = turnCost(idx);
    usedTokens += tokens;
    shortenedToolOutputs += shortened;
  };

  // Whole-or-nothing pair closure for the tail: the turn plus any partners
  // the budget walk has not picked yet (newer partners are already held).
  const tailClosure = (idx: number): number[] => {
    const closure = [idx];
    const queue = [idx];
    const seen = new Set([idx]);
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined) continue;
      for (const partner of partnerIndex.get(current) ?? []) {
        if (seen.has(partner)) continue;
        seen.add(partner);
        closure.push(partner);
        queue.push(partner);
      }
    }
    return closure;
  };

  if (shape.preserveWholeUserMessages) {
    for (let i = n - 1; i >= 0; i--) {
      const turn = turns[i];
      if (turn === undefined || isFoldableHandoffTurn(turn)) continue;
      if (isUserAskTurn(turn) && !isInteriorPairGap(i, partnerIndex)) pick(i);
      break;
    }
  }

  for (let i = n - 1; i >= 0; i--) {
    if (picked.has(i)) continue;
    const turn = turns[i];
    if (turn === undefined || isFoldableHandoffTurn(turn)) continue;
    const closure = (shape.pairSafe ? tailClosure(i) : [i]).filter(
      (idx) => !picked.has(idx),
    );
    let closureTokens = 0;
    for (const idx of closure) {
      const t = turns[idx];
      if (t === undefined || isFoldableHandoffTurn(t)) continue;
      closureTokens += excerptedTurnTokens(t, shape, idx === keepThinkingAt);
    }
    if (picked.size > 0 && usedTokens + closureTokens > budgetTokens) break;
    for (const idx of closure) pick(idx);
    if (usedTokens > budgetTokens) break;
  }

  return {
    picked,
    excerpted,
    shortenedToolOutputs,
    tailTokenEstimate: usedTokens,
  };
}

// Spine text of prior folds still live in the input: the next summary updates
// it instead of summarizing beside it. The spine turn stays in the summarized
// region; this is the copy the summarizer sees.
function extractFoldableSpineText(
  turns: readonly ConversationTurn[],
): string | undefined {
  const parts: string[] = [];
  for (const turn of turns) {
    if (!isCompactedSummaryTurn(turn)) continue;
    const text = firstTextBlock(turn);
    if (text !== undefined && text.length > 0) parts.push(text);
  }
  if (parts.length === 0) return undefined;
  return parts.join("\n");
}

export function createPruningCompactor(
  config: Partial<CompactorConfig> = {},
): Compactor {
  const cfg = { ...DEFAULT_COMPACTOR_CONFIG, ...config };

  return {
    name: "pruning-compactor",
    version: "1.9.0",
    async apply(
      turns: ConversationTurn[],
      _ctx: StrategyContext,
    ): Promise<StrategyResult<ConversationTurn[]>> {
      // Prior compacted summaries are folded into the next handoff, not frozen.
      const shape = resolveCompactionShape(cfg.compactionShape);

      if (turns.length <= compactorNoOpFloor()) {
        return {
          output: turns,
          record: {
            strategy: this.name,
            version: this.version,
            parameters: {
              compactionShape: shape,
              ...extraInstructionParameter(cfg),
            },
            reason: "no compaction needed",
            decisions: { agedImageCount: 0 },
          },
        };
      }

      // callId → name/path for stubs, over the full transcript so a kept
      // result can still name its path when its call turn was summarized.
      const callIndex = buildCallIndex(turns);

      const pairs = buildPairIndex(turns);
      const partnerIndex = buildPartnerIndex(pairs);

      // Newest→oldest whole pairs until the token budget, then excerpt.
      // Stored turns keep full bodies; only the live copies are excerpted.
      const tail = selectTail(turns, shape, partnerIndex);
      const aged = await ageImagesOutsidePicked(turns, tail.picked);
      const picked = tail.picked;

      const tailTurns: ConversationTurn[] = [...picked]
        .sort((a, b) => a - b)
        .flatMap((idx) => {
          const turn = aged.turns[idx];
          return turn === undefined ? [] : [tail.excerpted.get(idx) ?? turn];
        });

      const excludedIndices: number[] = [];
      for (let i = 0; i < aged.turns.length; i++) {
        if (!picked.has(i)) excludedIndices.push(i);
      }

      const excludedTurns = excludedIndices.flatMap((i) => {
        const turn = aged.turns[i];
        return turn === undefined ? [] : [turn];
      });
      const repeatedErrors = repeatedErroredResultCallIds(
        excludedTurns,
        callIndex,
      );
      // Live fold is the thin spine plus the token-capped tail; file-edit
      // pairs, errors, and the initiating task fold into the fat handoff.
      const summarizedTurns = excludedTurns;

      // Nothing foldable: do not invent an empty summary, but still emit
      // selectTail's excerpted live copies (plus image-aged turns and their
      // spill blobs) and stub superseded reads when the tail is the whole
      // transcript.
      if (summarizedTurns.length === 0) {
        const liveTurns =
          tail.excerpted.size === 0
            ? aged.turns
            : aged.turns.map((turn, idx) => tail.excerpted.get(idx) ?? turn);
        const pathToReads = buildPathToReads(liveTurns, callIndex);
        const supersededReads = supersededReadCallIds(pathToReads);
        const output =
          supersededReads.size === 0
            ? liveTurns
            : liveTurns.map((t) =>
                stubSupersededReads(t, supersededReads, callIndex),
              );
        return {
          output,
          record: {
            strategy: this.name,
            version: this.version,
            parameters: {
              compactionShape: shape,
              ...extraInstructionParameter(cfg),
            },
            reason: "no compaction needed",
            decisions: {
              tailBudgetTokens: shape.tailBudgetTokens,
              tailTokenEstimate: tail.tailTokenEstimate,
              shortenedToolOutputs: tail.shortenedToolOutputs,
              agedImageCount: aged.agedImageCount,
              supersededReadCount: supersededReads.size,
              liveTokenEstimate: estimateContextTokens(output),
            },
          },
          ...(aged.blobs.length > 0 ? { blobs: aged.blobs } : {}),
        };
      }

      // Path-dedup only among surviving turns.
      const pathToReads = buildPathToReads(tailTurns, callIndex);
      const supersededReads = supersededReadCallIds(pathToReads);

      // Repeat folds update the prior summary instead of summarizing beside it.
      const priorSummaryForFold = extractFoldableSpineText(aged.turns);
      const operatorCtx = cfg.summaryContext?.();
      const summaryCtx: SummaryContext | undefined =
        priorSummaryForFold === undefined
          ? operatorCtx
          : { ...operatorCtx, priorSummary: priorSummaryForFold };
      let summary: string;
      let summarizeFallback: SummarizerFailureClass | undefined;
      const stubSummary = (): string =>
        buildTurnSummary(summarizedTurns, cfg.summaryMaxChars);
      try {
        summary =
          cfg.summarize !== undefined
            ? await cfg.summarize(summarizedTurns, summaryCtx)
            : stubSummary();
      } catch (error) {
        const failureClass = classifySummarizerFailure(error);
        // A lifecycle abort is operator intent, not a lossy fallback: keep the
        // prior context so the wrapCompactor race cannot land a stub fold.
        if (failureClass === "aborted") {
          return {
            output: turns,
            record: {
              strategy: this.name,
              version: this.version,
              parameters: {
                compactionShape: shape,
                ...extraInstructionParameter(cfg),
              },
              reason: "summarize failed",
              decisions: {
                summarizeFailed: 1,
                agedImageCount: aged.agedImageCount,
              },
            },
          };
        }
        summarizeFallback = failureClass;
        summary = stubSummary();
      }
      if (summary.trim().length === 0) {
        summarizeFallback = summarizeFallback ?? "empty";
        summary = stubSummary();
      }
      if (summary.trim().length === 0) {
        return {
          output: turns,
          record: {
            strategy: this.name,
            version: this.version,
            parameters: {
              compactionShape: shape,
              ...extraInstructionParameter(cfg),
            },
            reason: "summarize failed",
            decisions: {
              summarizeFailed: 1,
              agedImageCount: aged.agedImageCount,
            },
          },
        };
      }

      // Verify pass: the handoff must still carry the dropped turns'
      // continuation facts (goal, next action, exact names, blockers). Lossy
      // summaries repair deterministically; contradicting ones abort the fold.
      const verified = verifyOrRepair(
        summary,
        extractContinuationFacts(summarizedTurns),
        cfg.summaryMaxChars,
      );
      if (verified.aborted) {
        return {
          output: turns,
          record: {
            strategy: this.name,
            version: this.version,
            parameters: {
              compactionShape: shape,
            },
            reason: "verify failed — keeping prior context",
            decisions: {
              verifyAborted: 1,
              verifyMissing: verified.misses.map((m) => m.kind),
              agedImageCount: aged.agedImageCount,
            },
          },
        };
      }
      summary = verified.summary;
      const verifyDecisions =
        verified.repaired && verified.misses.length > 0
          ? {
              verifyRepaired: 1,
              verifyMissing: verified.misses.map((m) => m.kind),
            }
          : {};

      // The summary is framed as user content: a user-role turn survives every
      // adapter unchanged, a system-role turn does not (Anthropic drops
      // mid-conversation system turns under a system-prompt override; Grok
      // emits them as a stray mid-stream system message). Activated tools
      // outlive the fold, so the handoff states them verbatim.
      //
      // The fold writes a fat structured handoff file (goal, constraints,
      // decisions, evidence markers, files/commands, verification, dead ends,
      // next actions, verbatim exact-facts appendix) under one stable latest
      // key, and keeps only a thin spine plus a pointer to that file in the
      // live prompt. The spine unions carried facts with new ones; dropped
      // prior spines are adopted into the evidence archive so the completeness
      // gate still certifies the fold.
      const priorFileText = await cfg.readPriorHandoff?.();
      const handoff = buildHandoffFold(summarizedTurns, summary, {
        ...(priorFileText !== undefined ? { priorFileText } : {}),
        ...(summaryCtx?.activatedTools !== undefined
          ? { activatedTools: summaryCtx.activatedTools }
          : {}),
      });
      const summaryTurn: ConversationTurn = {
        role: "user",
        content: [{ type: "text", text: handoff.spineText }],
        timestamp:
          excludedTurns[excludedTurns.length - 1]?.timestamp ?? Date.now(),
      };

      // Tail turns stay contentful except for path-dedup: older successful
      // re-reads of the same file become one-line stubs, the newest stays
      // whole, and error results are never stubbed. Tail turns keep live
      // base64 so a just-pasted screenshot still reaches the model.
      const process = (t: ConversationTurn): ConversationTurn =>
        stubSupersededReads(t, supersededReads, callIndex);
      const liveOutput = separateAdjacentUserTurns(
        coalesceAdjacentTextTurns([summaryTurn, ...tailTurns.map(process)]),
      );

      return {
        output: liveOutput,
        record: {
          strategy: this.name,
          version: this.version,
          parameters: {
            summaryMaxChars: cfg.summaryMaxChars,
            maxAnchorTurns: cfg.maxAnchorTurns,
            compactionShape: shape,
            ...extraInstructionParameter(cfg),
          },
          reason: `compacted ${summarizedTurns.length} turns, keeping ${tailTurns.length} tail${
            summarizeFallback !== undefined
              ? ` (statistics-only stub: ${summarizeFallback})`
              : ""
          }`,
          decisions: {
            summarizedTurnCount: summarizedTurns.length,
            anchorTurnCount: 0,
            recentTurnCount: tailTurns.length,
            tailBudgetTokens: shape.tailBudgetTokens,
            tailTokenEstimate: tail.tailTokenEstimate,
            shortenedToolOutputs: tail.shortenedToolOutputs,
            summaryLength: summary.length,
            handoffBlobKey: handoff.blob.key,
            handoffSpineLength: handoff.spineText.length,
            handoffFileLength: handoff.blob.bytes.length,
            agedImageCount: aged.agedImageCount,
            supersededReadCount: supersededReads.size,
            repeatedErrorCount: repeatedErrors.size,
            liveTokenEstimate: estimateContextTokens(liveOutput),
            ...(summarizeFallback !== undefined
              ? {
                  summarizeFailed: 1,
                  summarizeFailureKind: summarizeFallback,
                }
              : {}),
            ...verifyDecisions,
          },
        },
        blobs: [...aged.blobs, handoff.blob],
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
      if (textBlock !== undefined)
        lastUserMessage = textBlock.text.slice(0, 200);
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
  return summary.length > maxChars
    ? summary.slice(0, maxChars - 3) + "..."
    : summary;
}
