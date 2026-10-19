import fs from "node:fs";
import path from "node:path";
import { type } from "arktype";
import git from "isomorphic-git";
import {
  createIsogitStore,
  type CommitSigner,
} from "@intx/storage-isogit/node";
import {
  ContentBlock,
  ConnectorThreadState,
  type AuditStore,
  TokenUsage,
  type ConversationTurn,
  type PendingOperation,
} from "@intx/types/runtime";
import { getLogger } from "@intx/log";
import {
  createSegmentedJSONLWriter,
  highestSegmentIndex,
  listSegmentFiles,
  segmentFileName,
} from "./incremental-jsonl.js";
import type { ContextStore } from "@intx/types/runtime";
import { LOG_NAMESPACE_ROOT } from "../branding.js";
import { loadOrCreateCommitSigner } from "./commit-signer.js";
import { withResolvedDirLock } from "./session-dir-lock.js";
import { scrubPersistedPendingOperations } from "./pending-snapshot-scrub.js";
import {
  parsePendingApprovalRecord,
  pendingApprovalRecord,
  type PendingApprovalRecord,
  StoredPendingOperationSchema,
} from "./pending-approval-record.js";

const TURNS_FILE = "turns.jsonl";
const PROMPT_FILE = "prompt.jsonl";
const RESPONSE_FILE = "response.jsonl";
const MANIFEST_FILE = "manifest.jsonl";
const METADATA_FILE = "metadata.json";
// Append-only tokenUsage sidecar (CL-10667): a per-turn line keyed to the
// turn frontier so per-commit metadata.json rewrites stop re-hashing token
// data. No consumer ever read response.jsonl (sessions list, resume crash
// recovery all read the turns store), so it is folded away entirely; see
// store.writeResponse.
const TOKEN_USAGE_SIDECAR_FILE = "token-usage.jsonl";
const TOOL_OUTPUT_DIR = "tool-output";
const EVIDENCE_ARCHIVE_DIR = "evidence-archive";
const OWNER_MARKER_FILE = "session-owner.json";

const log = getLogger([LOG_NAMESPACE_ROOT, "session", "context-store"]);

/**
 * One isomorphic-git cache per session directory. The object is the cache
 * documented by isomorphic-git: index reads stay memoized, and `isIndexStale`
 * still reloads `.git/index` when another process (or the vendor store, which
 * does not share this object) rewrites it. Never reuse one cache across dirs.
 */
type GitCache = object;

function cachedGit(
  dir: string,
  cache: GitCache,
): { fs: typeof fs; dir: string; cache: GitCache } {
  return { fs, dir, cache };
}

const VENDOR_COMMIT_ROOT_FILES = new Set([
  TURNS_FILE,
  PROMPT_FILE,
  RESPONSE_FILE,
  MANIFEST_FILE,
  METADATA_FILE,
]);

const BLOB_EXTENSIONS: Readonly<Record<string, string>> = {
  "text/plain": ".txt",
  "application/json": ".json",
};

const UNSAFE_FILENAME_CHARS = /[^a-zA-Z0-9_-]/g;

/**
 * Commit-time record of the contiguous turn segments tracked at that commit.
 * `readAt` reads this blob instead of walking the commit tree, and reads the
 * listed segments' blobs concurrently. Recomputed from disk truth every
 * commit, so a worktree manifest left behind by a failed commit self-corrects
 * on the next one.
 */
const SEGMENT_MANIFEST_FILE = "segment-manifest.json";
const EMPTY_SEGMENT_MANIFEST = JSON.stringify({ turnSegments: [] });

const SegmentManifestSchema = type({
  turnSegments: "string[]",
});

// Only rolling-segment names are ever written here; anything else in a read
// manifest means it was not written by this store.
const TURN_SEGMENT_NAME_PATTERN = /^turns(-\d+)?\.jsonl$/;

const ConversationTurnSchema = type({
  role: "'user' | 'assistant' | 'system'",
  content: ContentBlock.array(),
  "model?": "string",
  timestamp: "number",
});

// Persisted turns are immutable once appended; re-parsed history rebuilds its
// memo entries anyway, so this skips re-serializing an unchanged history on
// every comparison (contentPrefixLength).
const turnJsonMemo = new WeakMap<ConversationTurn, string>();

function turnJson(turn: ConversationTurn): string {
  const memo = turnJsonMemo.get(turn);
  if (memo !== undefined) return memo;
  const json = JSON.stringify(turn);
  turnJsonMemo.set(turn, json);
  return json;
}

async function pathExists(fullPath: string): Promise<boolean> {
  try {
    await fs.promises.access(fullPath);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return false;
    throw cause;
  }
}

async function readSegmentManifestText(dir: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(
      path.join(dir, SEGMENT_MANIFEST_FILE),
      "utf-8",
    );
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return null;
    throw cause;
  }
}

function blobExtensionFor(contentType: string | undefined): string {
  if (contentType === undefined) return "";
  return BLOB_EXTENSIONS[contentType] ?? "";
}

function sanitizeCallId(callId: string): string {
  if (callId.includes("..") || callId.includes("/")) {
    throw new Error(
      `callId contains unsafe characters: ${JSON.stringify(callId)}`,
    );
  }
  return callId.replace(UNSAFE_FILENAME_CHARS, "_");
}

/**
 * Epoch+uuid avoids numbered segments (`turns-0001.jsonl`) that base
 * readers treat as live history.
 */
export function versionedBaseName(baseName: string): string {
  const dot = baseName.lastIndexOf(".");
  const stem = dot === -1 ? baseName : baseName.slice(0, dot);
  const ext = dot === -1 ? "" : baseName.slice(dot);
  const uuid = globalThis.crypto.randomUUID().replaceAll("-", "");
  return `${stem}-${Date.now()}-${uuid}${ext}`;
}

/**
 * Parse conversation turns out of one JSONL segment. A crash can tear the
 * final line of the active segment mid-write; `tolerateTornTail` drops it.
 * Null padding from a stale keepBytes write is stripped. `skipMalformed`
 * drops (or partially recovers) a bad line anywhere and keeps surrounding
 * history — used by `loadRecentTurns` and the reactor's `load()` recovery
 * path. A truncated stub glued to the next append still yields a trailing
 * complete turn via `recoverTurnFromGluedLine`.
 */
function recoverTurnFromGluedLine(line: string): ConversationTurn | null {
  // Walk every `{` start: a truncated prefix glued onto a complete record
  // parses only from the start of that complete record to end-of-line.
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "{") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line.slice(i));
    } catch {
      continue;
    }
    const result = ConversationTurnSchema(raw);
    if (!(result instanceof type.errors)) return result;
  }
  return null;
}

function parseSegmentTurns(
  text: string,
  tolerateTornTail: boolean,
  fileName = "turns segment",
  skipMalformed = false,
  approvals?: PendingOperation[],
): ConversationTurn[] {
  if (text.length === 0) return [];
  // POSIX truncate past EOF pads with `\0`. Strip them so the rest of the JSONL
  // remains parseable instead of dying on Unrecognized token '\u0000'.
  const cleaned = text.includes("\0") ? text.replaceAll("\0", "") : text;
  if (cleaned.length === 0) return [];
  const lines = cleaned.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  const turns: ConversationTurn[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.length === 0) continue;
    const isLast = i === lines.length - 1;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (cause) {
      if (skipMalformed) {
        const recovered = recoverTurnFromGluedLine(line);
        if (recovered !== null) {
          log.warn?.(
            `recovered trailing turn from glued/malformed JSON at ${fileName} line ${i + 1}`,
          );
          turns.push(recovered);
          continue;
        }
        // Torn final line: drop it rather than warning as mid-file garbage.
        if (tolerateTornTail && isLast) break;
        log.warn?.(`skipping malformed JSON at ${fileName} line ${i + 1}`);
        continue;
      }
      if (tolerateTornTail && isLast) break;
      throw new Error(`${fileName} has malformed JSON at line ${i + 1}`, {
        cause,
      });
    }
    // Approval records share the log but are never history.
    const approval = parsePendingApprovalRecord(raw);
    if (approval !== null) {
      approvals?.push(approval);
      continue;
    }
    const result = ConversationTurnSchema(raw);
    if (result instanceof type.errors) {
      if (skipMalformed) {
        log.warn?.(
          `skipping unexpected structure at ${fileName} line ${i + 1}`,
        );
        continue;
      }
      throw new Error(
        `${fileName} has unexpected structure at line ${i + 1}: ${result.summary}`,
      );
    }
    turns.push(result);
  }
  return turns;
}

const EMPTY_TOKEN_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
} as const;

interface SessionMetadata {
  pendingOperations: PendingOperation[];
  tokenUsage: TokenUsage;
  connectorState: ConnectorThreadState | null;
}

function emptyMetadata(): SessionMetadata {
  return {
    pendingOperations: [],
    tokenUsage: { ...EMPTY_TOKEN_USAGE },
    connectorState: null,
  };
}

/**
 * CL-10667 metadata ownership. metadata.json now carries pendingOperations
 * and connectorState only; tokenUsage lives on an append-only sidecar keyed
 * to the turn frontier so per-commit rewrites stop re-hashing token data.
 * Legacy files still carry tokenUsage (the old vendor shape) and read as the
 * fallback when the sidecar holds nothing.
 */
const StoredMetadataSchema = type({
  pendingOperations: StoredPendingOperationSchema.array(),
  "tokenUsage?": TokenUsage,
  "connectorState?": type("null").or(ConnectorThreadState),
});

const TokenUsageSidecarLineSchema = type({
  turnIndex: "number",
  usage: TokenUsage,
});

async function readTextOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, "utf-8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return null;
    throw cause;
  }
}

/**
 * Last well-formed sidecar line wins; a torn line (append torn mid-write)
 * drops silently like a torn JSONL tail.
 */
async function readLatestSidecarUsage(dir: string): Promise<TokenUsage | null> {
  const raw = await readTextOrNull(path.join(dir, TOKEN_USAGE_SIDECAR_FILE));
  if (raw === null) return null;
  let latest: TokenUsage | null = null;
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      const result = TokenUsageSidecarLineSchema(JSON.parse(line));
      if (!(result instanceof type.errors)) latest = result.usage;
    } catch {
      // Torn or non-JSON line: keep the last good record.
    }
  }
  return latest;
}

function readMetadataDocument(raw: string): Pick<
  SessionMetadata,
  "pendingOperations" | "connectorState"
> & {
  legacyTokenUsage: TokenUsage | null;
} {
  const parsed: unknown = JSON.parse(raw);
  const result = StoredMetadataSchema(parsed);
  if (result instanceof type.errors) {
    throw new Error(
      `metadata.json has unexpected structure: ${result.summary}`,
    );
  }
  return {
    pendingOperations: result.pendingOperations,
    connectorState: result.connectorState ?? null,
    legacyTokenUsage: result.tokenUsage ?? null,
  };
}

/**
 * metadata.json + sidecar merge. Sidecar wins over a legacy tokenUsage field,
 * which wins over empty. Parse failures stay inside this function: a torn
 * "{not-json" document soft-defaults pending ops and connector state, but the
 * sidecar is read anyway. Letting the throw escape made load()'s catch assign
 * emptyMetadata() and report all-zero usage.
 */
async function readSessionMetadata(dir: string): Promise<SessionMetadata> {
  const sidecarUsage = await readLatestSidecarUsage(dir);
  let document: ReturnType<typeof readMetadataDocument> = {
    pendingOperations: [],
    connectorState: null,
    legacyTokenUsage: null,
  };
  try {
    const raw = await readTextOrNull(path.join(dir, METADATA_FILE));
    if (raw !== null && raw.length > 0) {
      document = readMetadataDocument(raw);
    }
  } catch (cause) {
    log.warn(
      "session metadata document unreadable; keeping sidecar usage and empty document defaults",
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  const tokenUsage = sidecarUsage ??
    document.legacyTokenUsage ?? { ...EMPTY_TOKEN_USAGE };
  return {
    pendingOperations: document.pendingOperations,
    tokenUsage,
    connectorState: document.connectorState,
  };
}

function sameTokenUsage(a: TokenUsage, b: TokenUsage): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite &&
    a.thinking === b.thinking
  );
}

/**
 * Extends accumulated tool-sequence state with one segment's turns. Unpaired
 * trailing tool_calls pass; dups and orphan results fail. Failure is monotone
 * in the accumulated id sets: once a duplicate call or orphan result enters,
 * no later segment can undo it, so a single forward pass per segment walks
 * the same longest-well-formed prefix the previous re-scan-per-length loop
 * picked, without rebuilding the merged history once per candidate length.
 */
function accumulateToolSequenceState(
  turns: readonly ConversationTurn[],
  calledIds: Set<string>,
  answeredIds: Set<string>,
): boolean {
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type === "tool_call") {
        if (calledIds.has(block.id)) return false;
        calledIds.add(block.id);
      } else if (block.type === "tool_result") {
        if (!calledIds.has(block.callId)) return false;
        if (answeredIds.has(block.callId)) return false;
        answeredIds.add(block.callId);
      }
    }
  }
  return true;
}

/**
 * Longest well-formed prefix of `[base, ...extras]`, as how many extras to
 * keep (0 = base only). Orphan tails from a fresh-writer compaction rewrite
 * reintroduce pre-compact tool turns; dropping them resumes a poisoned
 * session.
 */
function longestWellFormedExtraCount(
  baseTurns: readonly ConversationTurn[],
  parsedExtras: readonly ConversationTurn[][],
): number {
  const calledIds = new Set<string>();
  const answeredIds = new Set<string>();
  let wellFormed = accumulateToolSequenceState(
    baseTurns,
    calledIds,
    answeredIds,
  );
  let keep = 0;
  for (const extra of parsedExtras) {
    if (!wellFormed) break;
    wellFormed = accumulateToolSequenceState(extra, calledIds, answeredIds);
    if (wellFormed) keep += 1;
  }
  return keep;
}

async function unlinkExtraSegmentsFrom(
  dir: string,
  fromSegmentIndex: number,
  pendingSegmentPaths: Set<string>,
): Promise<number> {
  // First segment file index to drop (1 = turns-0001).
  let removed = 0;
  const highest = await highestSegmentIndex(dir, TURNS_FILE);
  for (let s = fromSegmentIndex; s <= highest; s++) {
    const name = segmentFileName(TURNS_FILE, s);
    const full = path.join(dir, name);
    if (await pathExists(full)) {
      await fs.promises.unlink(full);
      removed += 1;
    }
    // Stage remove even when already gone so commit can git-rm a tracked orphan.
    pendingSegmentPaths.add(name);
  }
  return removed;
}

/**
 * Display-only tail of the turn history. `truncated` means older segments
 * were unread, so a bounded transcript can still signal that more history
 * exists.
 */
export type RecentTurns = {
  readonly turns: ConversationTurn[];
  readonly truncated: boolean;
};

/**
 * Read only the newest segments needed to satisfy `minTurns`. Display-only
 * paths (TUI transcript hydration) need a recent window; full history stays
 * on `ContextStore.load()`. Orphan-tail recovery lives on `load()`, not
 * here, so this path stays O(window).
 */
export async function loadRecentTurns(
  dir: string,
  minTurns: number,
): Promise<RecentTurns> {
  const segments = await listSegmentFiles(dir, TURNS_FILE);
  if (segments.length === 0) return { turns: [], truncated: false };

  const collectedNewestFirst: ConversationTurn[][] = [];
  let total = 0;
  let truncated = false;
  for (let i = segments.length - 1; i >= 0; i--) {
    const name = segments[i];
    if (name === undefined) continue;
    const text = await fs.promises.readFile(path.join(dir, name), "utf-8");
    // Only the active segment can be mid-write; skip bad lines rather than
    // losing the transcript to one, the same as reactor load.
    const turns = parseSegmentTurns(
      text,
      i === segments.length - 1,
      name,
      true,
    );
    collectedNewestFirst.push(turns);
    total += turns.length;
    if (total >= minTurns) {
      truncated = i > 0;
      break;
    }
  }

  const turns: ConversationTurn[] = [];
  for (let i = collectedNewestFirst.length - 1; i >= 0; i--) {
    const chunk = collectedNewestFirst[i];
    if (chunk !== undefined) turns.push(...chunk);
  }
  return { turns, truncated };
}

interface ParsedLogSegment {
  turns: ConversationTurn[];
  approvals: PendingOperation[];
}

/**
 * Resilient parse of `turns.jsonl` alone (extras merged by the caller), so a
 * torn or poisoned base cannot block the healing write.
 */
async function readBaseLogFromDisk(dir: string): Promise<ParsedLogSegment> {
  const basePath = path.join(dir, TURNS_FILE);
  if (!(await pathExists(basePath))) return { turns: [], approvals: [] };
  const text = await fs.promises.readFile(basePath, "utf-8");
  const approvals: PendingOperation[] = [];
  const turns = parseSegmentTurns(text, true, TURNS_FILE, true, approvals);
  return { turns, approvals };
}

async function readOwnerMarker(
  dir: string,
): Promise<{ ownerId: string } | null> {
  try {
    const raw = await fs.promises.readFile(
      path.join(dir, OWNER_MARKER_FILE),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { ownerId?: unknown }).ownerId === "string"
    ) {
      return { ownerId: (parsed as { ownerId: string }).ownerId };
    }
    return null;
  } catch {
    return null;
  }
}

async function tryCreateOwnerMarker(
  dir: string,
  ownerId: string,
): Promise<boolean> {
  const full = path.join(dir, OWNER_MARKER_FILE);
  try {
    await fs.promises.writeFile(
      full,
      JSON.stringify({ ownerId, createdAt: Date.now() }),
      { encoding: "utf8", flag: "wx" },
    );
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "EEXIST") {
      return false;
    }
    throw cause;
  }
}

const COMPACTED_TURN_PREFIX = "[Compacted prior context]";
const THINKING_ONLY_OMITTED = "[thinking-only turn omitted]";
const EXCERPT_MARKER = "\n[tail-shortened ";
const EXCERPT_CLOSE = "full text remains in the archived transcript]";

function firstTurnText(turn: ConversationTurn): string | undefined {
  for (const block of turn.content) {
    if (block.type === "text") return block.text;
  }
  return undefined;
}

function isCompactionMarker(turn: ConversationTurn): boolean {
  const text = firstTurnText(turn);
  if (text === undefined) return false;
  return (
    text.startsWith(COMPACTED_TURN_PREFIX) ||
    text === "[compact]" ||
    text === "[compaction]"
  );
}

function isSummaryTurn(turn: ConversationTurn): boolean {
  const text = firstTurnText(turn);
  return text !== undefined && text.startsWith(COMPACTED_TURN_PREFIX);
}

function sameTurnContent(a: ConversationTurn, b: ConversationTurn): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function joinedBlockText(
  content: readonly { type: string; text?: string }[],
): string {
  let text = "";
  for (const part of content) {
    if (part.type === "text" && part.text !== undefined) text += part.text;
  }
  return text;
}

function isExcerptText(original: string, excerpted: string): boolean {
  const at = excerpted.indexOf(EXCERPT_MARKER);
  if (at < 0) return false;
  const head = excerpted.slice(0, at);
  if (head.length === 0 || !original.startsWith(head)) return false;
  const close = excerpted.indexOf(EXCERPT_CLOSE);
  if (close < 0) return false;
  let tail = excerpted.slice(close + EXCERPT_CLOSE.length);
  if (tail.startsWith("\n")) tail = tail.slice(1);
  if (tail.length === 0) return head.length < original.length;
  return original.endsWith(tail) && head.length + tail.length < original.length;
}

function isOmissionStub(stub: string): boolean {
  return (
    /\[.+ — \d+ chars omitted from context; source unchanged\./.test(stub) ||
    /\[.+ — \d+ chars, omitted\]/.test(stub)
  );
}

function toolCallIds(turn: ConversationTurn): string[] {
  const ids: string[] = [];
  for (const block of turn.content) {
    if (block.type === "tool_call") ids.push(block.id);
  }
  return ids;
}

function resultCallIds(turn: ConversationTurn): string[] {
  const ids: string[] = [];
  for (const block of turn.content) {
    if (block.type === "tool_result") ids.push(block.callId);
  }
  return ids;
}

function sameIdList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function resultProjects(
  source: Extract<ConversationTurn["content"][number], { type: "tool_result" }>,
  out: Extract<ConversationTurn["content"][number], { type: "tool_result" }>,
): boolean {
  if (source.callId !== out.callId) return false;
  if ((source.isError === true) !== (out.isError === true)) return false;
  if (JSON.stringify(source.content) === JSON.stringify(out.content))
    return true;
  const sourceText = joinedBlockText(source.content);
  const outText = joinedBlockText(out.content);
  const stub = out.content[0];
  if (
    out.content.length === 1 &&
    stub !== undefined &&
    stub.type === "text" &&
    isOmissionStub(outText)
  ) {
    return sourceText.length > 0;
  }
  if (source.content.length !== out.content.length) return false;
  for (let index = 0; index < source.content.length; index++) {
    const sourcePart = source.content[index];
    const outPart = out.content[index];
    if (sourcePart === undefined || outPart === undefined) return false;
    if (sourcePart.type !== outPart.type) return false;
    if (sourcePart.type === "text" && outPart.type === "text") {
      if (sourcePart.text === outPart.text) continue;
      if (isExcerptText(sourcePart.text, outPart.text)) continue;
      return false;
    }
    if (JSON.stringify(sourcePart) !== JSON.stringify(outPart)) return false;
  }
  return true;
}

function blocksProject(
  source: ConversationTurn["content"],
  out: ConversationTurn["content"],
): boolean {
  const sourceBlocks = source.filter(
    (block) => block.type !== "thinking" && block.type !== "redacted_thinking",
  );
  if (
    sourceBlocks.length === 0 &&
    out.length === 1 &&
    out[0]?.type === "text" &&
    out[0].text === THINKING_ONLY_OMITTED
  ) {
    return source.some(
      (block) =>
        block.type === "thinking" || block.type === "redacted_thinking",
    );
  }
  if (sourceBlocks.length !== out.length) return false;
  for (let index = 0; index < sourceBlocks.length; index++) {
    const sourceBlock = sourceBlocks[index];
    const outBlock = out[index];
    if (sourceBlock === undefined || outBlock === undefined) return false;
    if (JSON.stringify(sourceBlock) === JSON.stringify(outBlock)) continue;
    if (
      sourceBlock.type === "tool_result" &&
      outBlock.type === "tool_result" &&
      resultProjects(sourceBlock, outBlock)
    ) {
      continue;
    }
    return false;
  }
  return true;
}

function isPlainTextTurn(turn: ConversationTurn): boolean {
  return !turn.content.some(
    (block) => block.type === "tool_call" || block.type === "tool_result",
  );
}

function projectsFrom(
  source: ConversationTurn,
  out: ConversationTurn,
): boolean {
  if (sameTurnContent(source, out)) return true;
  if (source.role !== out.role) return false;
  if (!sameIdList(toolCallIds(source), toolCallIds(out))) return false;
  if (!sameIdList(resultCallIds(source), resultCallIds(out))) return false;
  return blocksProject(source.content, out.content);
}

function sameTurnBody(a: ConversationTurn, b: ConversationTurn): boolean {
  return (
    a.role === b.role && JSON.stringify(a.content) === JSON.stringify(b.content)
  );
}

function coalescedSpan(
  live: readonly ConversationTurn[],
  end: number,
  out: ConversationTurn,
): number {
  if (!isPlainTextTurn(out)) return 0;
  const target = JSON.stringify(out.content);
  const parts: ConversationTurn["content"][number][] = [];
  for (let start = end - 1; start >= 0; start--) {
    const source = live[start];
    if (
      source === undefined ||
      source.role !== out.role ||
      !isPlainTextTurn(source)
    ) {
      return 0;
    }
    parts.unshift(...source.content);
    const span = end - start;
    if (span >= 2 && JSON.stringify(parts) === target) return span;
    if (parts.length > out.content.length) return 0;
  }
  return 0;
}

function tailProjectsFrom(
  live: readonly ConversationTurn[],
  rest: readonly ConversationTurn[],
): boolean {
  if (rest.length === 0 || rest.length > live.length) return false;
  let cursor = live.length;
  let mutated = false;
  for (let index = rest.length - 1; index >= 0; index--) {
    const out = rest[index];
    if (out === undefined || cursor <= 0) return false;
    const candidate = live[cursor - 1];
    if (candidate !== undefined && projectsFrom(candidate, out)) {
      if (!sameTurnBody(candidate, out)) mutated = true;
      cursor--;
      continue;
    }
    const span = coalescedSpan(live, cursor, out);
    if (span >= 2) {
      mutated = true;
      cursor -= span;
      continue;
    }
    return false;
  }
  return cursor > 0 && mutated;
}

function isCompactionOf(
  live: readonly ConversationTurn[],
  next: readonly ConversationTurn[],
): boolean {
  if (live.length === 0 || next.length === 0) return false;
  let sawSummary = false;
  const rest: ConversationTurn[] = [];
  for (const turn of next) {
    if (isCompactionMarker(turn)) {
      if (isSummaryTurn(turn)) sawSummary = true;
      continue;
    }
    rest.push(turn);
  }
  if (!sawSummary) return false;
  return tailProjectsFrom(live, rest);
}

async function listIndexPaths(
  dir: string,
  cache: GitCache,
): Promise<Set<string>> {
  return new Set(await git.listFiles({ ...cachedGit(dir, cache) }));
}

/**
 * Segment names contiguous from the base name, derived from one readdir of
 * the session dir. Equivalent to listSegmentFiles without its per-candidate
 * stat; a readdir is shared by every staging check in one commit.
 */
function contiguousSegmentNamesFromListing(
  names: ReadonlySet<string>,
  baseName: string,
): string[] {
  if (!names.has(baseName)) return [];
  const out = [baseName];
  for (let index = 1; ; index++) {
    const name = segmentFileName(baseName, index);
    if (!names.has(name)) break;
    out.push(name);
  }
  return out;
}

function highestSegmentIndexFromListing(
  names: ReadonlySet<string>,
  baseName: string,
): number {
  const dot = baseName.lastIndexOf(".");
  const stem = dot === -1 ? baseName : baseName.slice(0, dot);
  const ext = dot === -1 ? "" : baseName.slice(dot);
  const pattern = new RegExp(
    `^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)${ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
  );
  let highest = names.has(baseName) ? 0 : -1;
  for (const name of names) {
    const match = pattern.exec(name);
    if (match === null) continue;
    const index = Number(match[1]);
    if (Number.isFinite(index) && index > highest) highest = index;
  }
  return highest;
}

/**
 * Size, mtime, and inode of one segment file. Compared to the fingerprint
 * saved at the last publish so a byte change stages the file and an unchanged
 * file is not re-read.
 */
interface SegmentStat {
  bytes: number;
  mtimeMs: number;
  ino: number;
}

function segmentStatDrifted(
  observed: SegmentStat | undefined,
  published: SegmentStat | undefined,
): boolean {
  if (observed === undefined || published === undefined) return true;
  return (
    observed.bytes !== published.bytes ||
    observed.mtimeMs !== published.mtimeMs ||
    observed.ino !== published.ino
  );
}

/**
 * One readdir of the session dir answers every worktree-existence check in a
 * single commit, including the lazy listing of the tool-output dir. Contiguous
 * turn and prompt segments are statted once here; that fingerprint is the
 * drift signal, not a content read. Surveyed after the staged writes land,
 * used before the lock releases.
 */
interface WorktreeListing {
  top: ReadonlySet<string>;
  segmentStats: ReadonlyMap<string, SegmentStat>;
  toolOutputFiles: () => Promise<ReadonlySet<string>>;
}

async function segmentStatsForListing(
  dir: string,
  top: ReadonlySet<string>,
  turnsBaseName: string,
): Promise<Map<string, SegmentStat>> {
  const names = [
    ...contiguousSegmentNamesFromListing(top, turnsBaseName),
    ...contiguousSegmentNamesFromListing(top, PROMPT_FILE),
  ];
  const stats = new Map<string, SegmentStat>();
  await Promise.all(
    names.map(async (name) => {
      const fileStats = await fs.promises.stat(path.join(dir, name));
      stats.set(name, {
        bytes: fileStats.size,
        mtimeMs: fileStats.mtimeMs,
        ino: fileStats.ino,
      });
    }),
  );
  return stats;
}

async function surveyWorktree(
  dir: string,
  turnsBaseName: string,
): Promise<WorktreeListing> {
  const top = new Set(await fs.promises.readdir(dir));
  const segmentStats = await segmentStatsForListing(dir, top, turnsBaseName);
  let blobListing: Promise<ReadonlySet<string>> | null = null;
  return {
    top,
    segmentStats,
    toolOutputFiles() {
      blobListing ??= fs.promises
        .readdir(path.join(dir, TOOL_OUTPUT_DIR))
        .then((names) => new Set(names))
        .catch((cause: unknown) => {
          if (
            cause instanceof Error &&
            "code" in cause &&
            cause.code === "ENOENT"
          ) {
            return new Set<string>();
          }
          throw cause;
        });
      return blobListing;
    },
  };
}

async function worktreeListingHas(
  dir: string,
  listing: WorktreeListing,
  filepath: string,
): Promise<boolean> {
  const slash = filepath.indexOf("/");
  if (slash === -1) return listing.top.has(filepath);
  if (filepath.startsWith(`${TOOL_OUTPUT_DIR}/`)) {
    const nested = filepath.slice(TOOL_OUTPUT_DIR.length + 1);
    return (await listing.toolOutputFiles()).has(nested);
  }
  // Unknown nested shape: fall back to the direct probe.
  return pathExists(path.join(dir, filepath));
}

async function extraSegmentNamesAtCommit(
  dir: string,
  hash: string,
  cache: GitCache,
): Promise<string[]> {
  const listing = await git.listFiles({ ...cachedGit(dir, cache), ref: hash });
  const present = new Set(listing);
  const names: string[] = [];
  for (let index = 1; ; index++) {
    const name = segmentFileName(TURNS_FILE, index);
    if (!present.has(name)) break;
    names.push(name);
  }
  return names;
}

async function blobTextAtCommit(
  dir: string,
  hash: string,
  filepath: string,
  cache: GitCache,
): Promise<string> {
  const { blob } = await git.readBlob({
    ...cachedGit(dir, cache),
    oid: hash,
    filepath,
  });
  return new TextDecoder().decode(blob);
}

/**
 * Contiguous turn extras tracked at `hash`: the commit-time manifest when
 * present, else the ref-tree walk for commits that predate the manifest.
 * Manifest entries are validated because a torn or hand-corrupted blob must
 * degrade to the tree walk, never fail the readAt.
 */
function isNotFoundError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "NotFoundError";
}

async function turnSegmentNamesAtCommit(
  dir: string,
  hash: string,
  cache: GitCache,
): Promise<string[]> {
  let manifest: string | null = null;
  try {
    manifest = await blobTextAtCommit(dir, hash, SEGMENT_MANIFEST_FILE, cache);
  } catch (cause) {
    // A commit without the manifest is the pre-manifest normal case; any
    // other read error falls through to the tree walk as well.
    if (!isNotFoundError(cause)) {
      log.warn(
        "unreadable segment manifest at commit {hash}; re-deriving from the commit tree",
        { hash, cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
  }
  if (manifest !== null) {
    try {
      const parsed: unknown = JSON.parse(manifest);
      const result = SegmentManifestSchema(parsed);
      if (
        !(result instanceof type.errors) &&
        result.turnSegments.every(
          (name) => name !== TURNS_FILE && TURN_SEGMENT_NAME_PATTERN.test(name),
        )
      ) {
        return result.turnSegments;
      }
      log.warn(
        "malformed segment manifest at commit {hash}; re-deriving from the commit tree",
        { hash },
      );
    } catch {
      // Torn or non-JSON bytes degrade to the tree walk, same as a missing one.
      log.warn(
        "malformed segment manifest at commit {hash}; re-deriving from the commit tree",
        { hash },
      );
    }
  }
  return extraSegmentNamesAtCommit(dir, hash, cache);
}

async function resetIndexPaths(
  dir: string,
  filepaths: readonly string[],
  cache: GitCache,
): Promise<void> {
  for (const filepath of filepaths) {
    try {
      await git.resetIndex({ ...cachedGit(dir, cache), filepath });
    } catch {
      // Not in the index; vendor restore already covers its own paths.
    }
  }
}

async function headOid(dir: string, cache: GitCache): Promise<string | null> {
  try {
    return await git.resolveRef({ ...cachedGit(dir, cache), ref: "HEAD" });
  } catch {
    return null;
  }
}

/**
 * Every on-disk turn segment (gapped strays included), keyed by name.
 * Captured before a staged rewrite lands so a failed commit can restore the
 * published generation.
 */
async function snapshotTurnSegments(
  dir: string,
  baseName: string,
): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const highest = await highestSegmentIndex(dir, baseName);
  for (let index = 0; index <= highest; index++) {
    const name = segmentFileName(baseName, index);
    try {
      snapshot.set(
        name,
        await fs.promises.readFile(path.join(dir, name), "utf-8"),
      );
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        continue;
      throw cause;
    }
  }
  return snapshot;
}

/**
 * Inverse of snapshotTurnSegments: write every snapshotted segment back and
 * unlink any the landed rewrite created.
 */
async function restoreTurnSegments(
  dir: string,
  snapshot: ReadonlyMap<string, string>,
  baseName: string,
): Promise<void> {
  const names = new Set<string>(snapshot.keys());
  const highest = await highestSegmentIndex(dir, baseName);
  for (let index = 0; index <= highest; index++) {
    names.add(segmentFileName(baseName, index));
  }
  for (const name of names) {
    const full = path.join(dir, name);
    const text = snapshot.get(name);
    if (text === undefined) {
      if (await pathExists(full)) await fs.promises.unlink(full);
    } else {
      await fs.promises.writeFile(full, text);
    }
  }
}

/**
 * Stage contiguous on-disk segments for `baseName`; unstage any
 * higher-numbered or gapped segment a rewrite deleted, even when the pending
 * set was lost (crash between heal unlink and commit). Gapped strays are
 * unlinked, not re-added. Existence and index checks come from the shared
 * worktree listing and the shared tracked-index listing, so one readdir and
 * one tree walk serve every staged base name in the commit.
 *
 * `stageUnchanged` re-adds every contiguous name (disk-as-truth for a rewrite,
 * or the first commit of a store whose pending set may have been lost). After
 * this store has published once, steady-state commits stage a tracked segment
 * only when its listing fingerprint (size, mtime, inode) differs from the
 * fingerprint saved at the last publish. An unchanged fingerprint is not
 * passed to `git.add`, so the file is not re-read. Untracked names are still
 * added. Removals stay disk-as-truth either way, so a heal unlink still
 * unstages the same paths snapshot/restore would put back.
 */
async function reconcileSegmentStaging(
  dir: string,
  baseName: string,
  toAdd: string[],
  toRemove: string[],
  listing: WorktreeListing,
  tracked: ReadonlySet<string>,
  stageUnchanged: boolean,
  publishedSegmentStats: ReadonlyMap<string, SegmentStat>,
): Promise<void> {
  const contiguous = contiguousSegmentNamesFromListing(listing.top, baseName);
  if (stageUnchanged) {
    for (const name of contiguous) toAdd.push(name);
  } else {
    for (const name of contiguous) {
      if (!tracked.has(name)) {
        toAdd.push(name);
        continue;
      }
      if (
        segmentStatDrifted(
          listing.segmentStats.get(name),
          publishedSegmentStats.get(name),
        )
      ) {
        toAdd.push(name);
      }
    }
  }

  // Index 0 is the base name; numbered tails begin at 1. No base still
  // sweeps numbered files.
  const startIndex = Math.max(contiguous.length, 1);
  const highestDisk = highestSegmentIndexFromListing(listing.top, baseName);

  for (let index = startIndex; ; index++) {
    const name = segmentFileName(baseName, index);
    if (listing.top.has(name)) {
      // Gapped or post-contiguous stray — not part of the live history.
      await fs.promises.unlink(path.join(dir, name));
      toRemove.push(name);
      continue;
    }
    if (!tracked.has(name)) {
      if (index > highestDisk) break;
      continue;
    }
    toRemove.push(name);
  }
}

function extraCommitPaths(paths: readonly string[]): string[] {
  return paths.filter((filepath) => !VENDOR_COMMIT_ROOT_FILES.has(filepath));
}

/**
 * True when any managed path differs between HEAD and the worktree. Callers
 * must pass only managed paths — never "." or session junk like
 * partial.jsonl.
 *
 * Directories are not passed to the same statusMatrix as root files.
 * isomorphic-git applies `filepaths` inside the walk map, after it has already
 * readdir'd a directory and lstat'd each child, so including `tool-output`
 * stats every blob. Root files are checked first; a dirty one skips the
 * directory walk entirely. `walkBlobDirectories` is the separate signal for a
 * blob-only change: a store that has not yet observed the blob directories,
 * or whose directory fingerprint (mtime, inode) moved, still walks. A no-op
 * whose fingerprint is unchanged passes false and does not lstat every blob.
 */
async function managedPathsDiffer(
  dir: string,
  filepaths: readonly string[],
  cache: GitCache,
  walkBlobDirectories: boolean,
): Promise<boolean> {
  if (filepaths.length === 0) return false;
  const rootFiles: string[] = [];
  const nestedFiles: string[] = [];
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const filepath of filepaths) {
    if (seen.has(filepath)) continue;
    seen.add(filepath);
    if (filepath === TOOL_OUTPUT_DIR || filepath === EVIDENCE_ARCHIVE_DIR) {
      directories.push(filepath);
    } else if (filepath.includes("/")) {
      nestedFiles.push(filepath);
    } else {
      rootFiles.push(filepath);
    }
  }
  if (rootFiles.length > 0) {
    const matrix = await git.statusMatrix({
      ...cachedGit(dir, cache),
      filepaths: rootFiles,
    });
    if (matrix.some(([, head, workdir]) => head !== workdir)) return true;
  }
  for (const filepath of nestedFiles) {
    if (await nestedWorktreeDiffers(dir, filepath, cache)) return true;
  }
  if (!walkBlobDirectories) return false;
  for (const filepath of directories) {
    const matrix = await git.statusMatrix({
      ...cachedGit(dir, cache),
      filepaths: [filepath],
    });
    if (matrix.some(([, head, workdir]) => head !== workdir)) return true;
  }
  return false;
}

interface DirectoryFingerprint {
  mtimeMs: number;
  ino: number;
}

function sameDirectoryFingerprint(
  left: DirectoryFingerprint | null,
  right: DirectoryFingerprint | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.mtimeMs === right.mtimeMs && left.ino === right.ino;
}

async function directoryFingerprint(
  dir: string,
  name: string,
): Promise<DirectoryFingerprint | null> {
  try {
    const stats = await fs.promises.lstat(path.join(dir, name));
    if (!stats.isDirectory()) return null;
    return { mtimeMs: stats.mtimeMs, ino: stats.ino };
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return null;
    }
    throw cause;
  }
}

/**
 * HEAD-vs-worktree for one file nested under a managed directory, without
 * walking sibling blobs. Used only after root files already compared clean.
 */
async function nestedWorktreeDiffers(
  dir: string,
  filepath: string,
  cache: GitCache,
): Promise<boolean> {
  const full = path.join(dir, filepath);
  let worktree: Uint8Array | null = null;
  try {
    const stat = await fs.promises.lstat(full);
    if (!stat.isFile()) return true;
    worktree = await fs.promises.readFile(full);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      worktree = null;
    } else {
      throw cause;
    }
  }
  const head = await headOid(dir, cache);
  if (head === null) return worktree !== null;
  try {
    const { oid } = await git.readBlob({
      ...cachedGit(dir, cache),
      oid: head,
      filepath,
    });
    if (worktree === null) return true;
    const hashed = await git.hashBlob({ object: worktree });
    return hashed.oid !== oid;
  } catch (cause) {
    if (isNotFoundError(cause)) return worktree !== null;
    throw cause;
  }
}

/**
 * A parked call's approval is open while its call is in history, unanswered,
 * and the same call (id, name, and arguments). An op with no parked call is
 * an async marker and always passes. The first op actually accepted as open
 * wins for its correlationId: a closed record must not tombstone a later open
 * one, because load() lists the log before legacy metadata.json.
 */
function openPendingOperations(
  turns: readonly ConversationTurn[],
  candidates: readonly PendingOperation[],
): PendingOperation[] {
  const called = new Map<string, { name: string; arguments: unknown }>();
  const answered = new Set<string>();
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type === "tool_call") {
        if (!called.has(block.id)) {
          called.set(block.id, {
            name: block.name,
            arguments: block.arguments,
          });
        }
      } else if (block.type === "tool_result") answered.add(block.callId);
    }
  }
  const seen = new Set<string>();
  const open: PendingOperation[] = [];
  for (const op of candidates) {
    if (seen.has(op.correlationId)) continue;
    const call = op.suspendedCall;
    if (call !== undefined) {
      const historical = called.get(call.id);
      if (
        historical === undefined ||
        answered.has(call.id) ||
        historical.name !== call.name ||
        JSON.stringify(historical.arguments) !== JSON.stringify(call.arguments)
      ) {
        continue;
      }
    }
    seen.add(op.correlationId);
    open.push(op);
  }
  return open;
}

export interface SessionStores {
  storage: ContextStore;
  audit: AuditStore;
}

export interface SessionStoreOptions {
  signer?: CommitSigner;
  /**
   * Same id shares the marker. Omit for a random token: a prefix extension or
   * a compaction of the on-disk transcript stays on the shared log.
   */
  ownerId?: string;
}

let metadataPublishSeq = 0;

/**
 * Publish metadata.json only once the bytes are complete. writeFile on the
 * published name can crash mid-write and leave "{not-json" as metadata.json;
 * a temp sibling in the same directory plus rename is the published name
 * appearing with a finished document, same as partial.jsonl.
 */
async function publishMetadataDocument(
  dir: string,
  desired: string,
): Promise<void> {
  const target = path.join(dir, METADATA_FILE);
  const tmp = path.join(
    dir,
    `.${METADATA_FILE}.${process.pid}.${(metadataPublishSeq += 1)}.tmp`,
  );
  try {
    await fs.promises.writeFile(tmp, desired);
    await fs.promises.rename(tmp, target);
  } catch (cause) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw cause;
  }
}

/**
 * Interchange git-store wrapper that avoids O(session length) work per
 * checkpoint: turns write as rolling segments so only the active one
 * re-hashes; `base.commit()` keeps the vendor lock, durable commit,
 * signing, and GC.
 */
export async function createSessionStores(
  dir: string,
  opts?: SessionStoreOptions,
): Promise<SessionStores> {
  const signer = opts?.signer ?? (await loadOrCreateCommitSigner(dir));
  const base = await createIsogitStore(dir, signer);
  const pendingBlobFilepaths = new Set<string>();
  const pendingSegmentPaths = new Set<string>();
  const gitCache: GitCache = {};
  // Full contiguous re-stage until this store has observed a clean or published
  // generation. A fresh process heals disk the same way a rewrite does; later
  // commits stage a tracked segment only when its fingerprint drifted.
  let stageEveryContiguousSegment = true;
  // Fingerprints from the last publish. Segment stats avoid re-reading an
  // unchanged segment; blob directory stats are the signal that skips the
  // tool-output walk on a no-op commit.
  let publishedSegmentStats = new Map<string, SegmentStat>();
  let blobDirsObserved = false;
  let toolOutputFingerprint: DirectoryFingerprint | null = null;
  let evidenceFingerprint: DirectoryFingerprint | null = null;

  async function blobDirectoriesNeedWalk(): Promise<boolean> {
    if (!blobDirsObserved) return true;
    const tool = await directoryFingerprint(dir, TOOL_OUTPUT_DIR);
    const evidence = await directoryFingerprint(dir, EVIDENCE_ARCHIVE_DIR);
    return (
      !sameDirectoryFingerprint(tool, toolOutputFingerprint) ||
      !sameDirectoryFingerprint(evidence, evidenceFingerprint)
    );
  }

  async function rememberPublishedTree(
    listing: WorktreeListing,
  ): Promise<void> {
    publishedSegmentStats = new Map(listing.segmentStats);
    toolOutputFingerprint = await directoryFingerprint(dir, TOOL_OUTPUT_DIR);
    evidenceFingerprint = await directoryFingerprint(dir, EVIDENCE_ARCHIVE_DIR);
    blobDirsObserved = true;
  }
  const ownerToken = opts?.ownerId ?? globalThis.crypto.randomUUID();
  const explicitOwnerId = opts?.ownerId;
  let turnsBaseName = TURNS_FILE;
  let versionedBase: string | null = null;
  let writeTurnsSegmented = createSegmentedJSONLWriter(dir, TURNS_FILE);
  let liveTurnRefs: readonly ConversationTurn[] | null = null;
  let unpublishedRewrite: ConversationTurn[] | null = null;
  // metadata.json ownership (CL-10667): this store writes the file itself, so
  // the base's pendingConnectorState buffer would never land. The written
  // payload is the compare baseline — metadata.json changes only through this
  // path in-process, matching the segment writers' single-writer assumption.
  let connectorStateBuffer: ConnectorThreadState | null = null;
  let writtenMetadataJson: string | null = null;
  let metadataJsonSeeded = false;
  let sidecarUsage: TokenUsage | null = null;
  let sidecarUsageSeeded = false;

  // One sidecar line per tokenUsage CHANGE, keyed to the turn frontier the
  // store manages. Appending on change (instead of on every write call)
  // keeps the last line exactly what a crash resume reads without growing
  // one line per commit; usage is monotone, so an older line never wins.
  async function appendUsageSidecar(tokenUsage: TokenUsage): Promise<void> {
    if (!sidecarUsageSeeded) {
      sidecarUsage = await readLatestSidecarUsage(dir);
      sidecarUsageSeeded = true;
    }
    if (sidecarUsage !== null && sameTokenUsage(sidecarUsage, tokenUsage)) {
      return;
    }
    const turnIndex = (unpublishedRewrite ?? liveTurnRefs)?.length ?? 0;
    await fs.promises.appendFile(
      path.join(dir, TOKEN_USAGE_SIDECAR_FILE),
      `${JSON.stringify({ turnIndex, usage: tokenUsage })}\n`,
      "utf8",
    );
    sidecarUsage = { ...tokenUsage };
  }

  // A parked call's approval lives in the turn log, on a record line right
  // after the turn holding the call; the call's tool_result closes it, so an
  // approved call needs no second write to stop it re-arming. Keyed by
  // correlationId in log order. Record objects stay stable so the segmented
  // writer sees a new one as a prefix extension, and a closed one keeps its
  // line: dropping it would turn every later append into a rewrite.
  const approvalRecords = new Map<string, PendingApprovalRecord>();
  // Approvals a canonical turns.jsonl flush has already written. A versioned
  // base is not this set: load() never reads it, and the approval is not
  // copied onto metadata.json to compensate.
  const loggedApprovalIds = new Set<string>();
  // Line objects last passed to the canonical segmented writer, same refs, so
  // a later record can extend that prefix by one append instead of rewriting
  // the turns.
  let canonicalLines: readonly unknown[] | null = null;

  function adoptLoggedApprovals(ops: readonly PendingOperation[]): void {
    for (const op of ops) {
      if (!approvalRecords.has(op.correlationId)) {
        approvalRecords.set(op.correlationId, pendingApprovalRecord(op));
      }
      loggedApprovalIds.add(op.correlationId);
    }
  }

  function hasUnloggedApproval(): boolean {
    for (const id of approvalRecords.keys()) {
      if (!loggedApprovalIds.has(id)) return true;
    }
    return false;
  }

  // Located by call id, not turn identity, so a record follows an excerpted
  // copy of its turn through a compaction and is dropped with its call.
  function withApprovalRecords(turns: readonly ConversationTurn[]): {
    lines: readonly unknown[];
    included: string[];
  } {
    if (approvalRecords.size === 0) return { lines: turns, included: [] };
    const byCallId = new Map<string, string[]>();
    for (const [correlationId, record] of approvalRecords) {
      const callId = record.pendingApproval.suspendedCall?.id;
      if (callId === undefined) continue;
      const ids = byCallId.get(callId);
      if (ids === undefined) byCallId.set(callId, [correlationId]);
      else ids.push(correlationId);
    }
    const lines: unknown[] = [];
    const included: string[] = [];
    for (const turn of turns) {
      lines.push(turn);
      for (const block of turn.content) {
        if (block.type !== "tool_call") continue;
        const ids = byCallId.get(block.id);
        if (ids === undefined) continue;
        // A call id seen twice is malformed history; record it once.
        byCallId.delete(block.id);
        for (const id of ids) {
          const record = approvalRecords.get(id);
          if (record === undefined) continue;
          lines.push(record);
          included.push(id);
        }
      }
    }
    return { lines, included };
  }

  async function writeTurnLog(
    turns: readonly ConversationTurn[],
  ): Promise<void> {
    const { lines, included } = withApprovalRecords(turns);
    await writeSegmented(writeTurnsSegmented, lines);
    // Diversion writes a versioned base load() never reads. That flush is not
    // the canonical log, and the approval is not written to metadata.json.
    if (turnsBaseName !== TURNS_FILE) return;
    for (const id of included) loggedApprovalIds.add(id);
    canonicalLines = lines;
  }

  // The turns are already on disk. Extend the canonical log by the new record
  // lines only. A prefix extension appends; it does not rewrite the turns. A
  // writer with no memory of those bytes appends the line to the active
  // segment instead of rebuilding it.
  async function appendParkedRecords(
    published: readonly ConversationTurn[],
  ): Promise<void> {
    if (turnsBaseName !== TURNS_FILE) return;
    const callIds = new Set<string>();
    for (const turn of published) {
      for (const block of turn.content) {
        if (block.type === "tool_call") callIds.add(block.id);
      }
    }
    const pending: PendingApprovalRecord[] = [];
    for (const [id, record] of approvalRecords) {
      if (loggedApprovalIds.has(id)) continue;
      const callId = record.pendingApproval.suspendedCall?.id;
      if (callId === undefined || !callIds.has(callId)) continue;
      pending.push(record);
    }
    if (pending.length === 0) return;
    if (canonicalLines !== null) {
      const lines = [...canonicalLines, ...pending];
      await writeSegmented(writeTurnsSegmented, lines);
      canonicalLines = lines;
    } else {
      const names = await listSegmentFiles(dir, TURNS_FILE);
      const target = names.at(-1) ?? TURNS_FILE;
      const text = pending
        .map((record) => `${JSON.stringify(record)}\n`)
        .join("");
      await fs.promises.appendFile(path.join(dir, target), text);
      pendingSegmentPaths.add(target);
    }
    for (const record of pending) {
      loggedApprovalIds.add(record.pendingApproval.correlationId);
    }
    invalidateTurnsCache();
  }

  function retainedLegacyApprovals(raw: string | null): PendingOperation[] {
    if (raw === null || raw.length === 0) return [];
    try {
      return readMetadataDocument(raw).pendingOperations.filter(
        (op) =>
          op.suspendedCall !== undefined &&
          !loggedApprovalIds.has(op.correlationId),
      );
    } catch {
      return [];
    }
  }

  async function writeMetadataLive(metadata: {
    pendingOperations: PendingOperation[];
    tokenUsage: TokenUsage;
  }): Promise<void> {
    await appendUsageSidecar(metadata.tokenUsage);
    // Approval snapshot args would persist in the clear; scrub them at this
    // app-owned write (suspendedCall stays raw for the approved call's
    // re-dispatch). Parked approvals never go into metadata.json.
    for (const op of scrubPersistedPendingOperations(
      metadata.pendingOperations.filter(
        (pending) =>
          pending.suspendedCall !== undefined &&
          !approvalRecords.has(pending.correlationId),
      ),
    )) {
      approvalRecords.set(op.correlationId, pendingApprovalRecord(op));
    }
    // Turns are already on disk. A parked approval appends its record line
    // once, including while a rewrite is still unpublished, so load() of the
    // published log sees it before commit. No parked approval adds no write.
    if (hasUnloggedApproval()) {
      const published = liveTurnRefs ?? (await readLiveTurns());
      await appendParkedRecords(published);
    }
    if (!metadataJsonSeeded) {
      writtenMetadataJson = await readTextOrNull(path.join(dir, METADATA_FILE));
      metadataJsonSeeded = true;
    }
    // Async markers (no suspendedCall) and connectorState stay in this file.
    // A legacy parked approval already on disk stays until the canonical log
    // has it; this write does not put it back, and does not add a new one.
    const retained = retainedLegacyApprovals(writtenMetadataJson);
    const sideOps = [
      ...metadata.pendingOperations.filter(
        (pending) => pending.suspendedCall === undefined,
      ),
      ...retained,
    ];
    if (sideOps.length === 0 && connectorStateBuffer === null) {
      if (writtenMetadataJson !== null) {
        await fs.promises.rm(path.join(dir, METADATA_FILE), { force: true });
        pendingSegmentPaths.add(METADATA_FILE);
        writtenMetadataJson = null;
      }
      return;
    }
    if (retained.length > 0 && writtenMetadataJson !== null) {
      try {
        const onDisk = readMetadataDocument(writtenMetadataJson);
        const asyncOnDisk = onDisk.pendingOperations.filter(
          (op) => op.suspendedCall === undefined,
        );
        const asyncFromCall = metadata.pendingOperations.filter(
          (pending) => pending.suspendedCall === undefined,
        );
        const connectorSame =
          JSON.stringify(onDisk.connectorState ?? null) ===
          JSON.stringify(connectorStateBuffer);
        if (
          connectorSame &&
          JSON.stringify(asyncOnDisk) === JSON.stringify(asyncFromCall)
        ) {
          return;
        }
      } catch {
        // Unreadable legacy document: fall through and publish the side ops.
      }
    }
    const desired = JSON.stringify(
      {
        pendingOperations: scrubPersistedPendingOperations(sideOps),
        connectorState: connectorStateBuffer,
      },
      null,
      2,
    );
    if (writtenMetadataJson !== desired) {
      await publishMetadataDocument(dir, desired);
      writtenMetadataJson = desired;
    }
  }

  function divertToVersionedBases(): void {
    if (versionedBase !== null) return;
    versionedBase = versionedBaseName(TURNS_FILE);
    turnsBaseName = versionedBase;
    writeTurnsSegmented = createSegmentedJSONLWriter(dir, turnsBaseName);
  }

  function refPrefixLength(
    prev: readonly ConversationTurn[],
    next: readonly ConversationTurn[],
  ): number {
    const max = Math.min(prev.length, next.length);
    let prefix = 0;
    while (prefix < max && prev[prefix] === next[prefix]) prefix++;
    return prefix;
  }

  function contentPrefixLength(
    prev: readonly ConversationTurn[],
    next: readonly ConversationTurn[],
  ): number {
    const max = Math.min(prev.length, next.length);
    let prefix = 0;
    while (prefix < max) {
      const prevTurn = prev[prefix];
      const nextTurn = next[prefix];
      if (
        prevTurn === undefined ||
        nextTurn === undefined ||
        turnJson(prevTurn) !== turnJson(nextTurn)
      ) {
        break;
      }
      prefix++;
    }
    return prefix;
  }

  async function writeSegmented(
    writer: ReturnType<typeof createSegmentedJSONLWriter>,
    lines: readonly unknown[],
  ): Promise<void> {
    const { modifiedPaths } = await writer(lines);
    for (const filepath of modifiedPaths) pendingSegmentPaths.add(filepath);
  }

  /**
   * Per-generation live-turns parse cache. `load()`, `resolveFirstWrite`, and
   * the fresh-instance prompt path all read this instead of re-reading and
   * re-parsing the full segment set, so one turn cycle performs one parse of
   * the history (plus stats) instead of three. A stat change on any segment
   * invalidates that segment only — parses are reused segment by segment —
   * and every in-process mutation site invalidates explicitly, so anything
   * cached dies on the triggers the unbounded disk read it replaced would
   * have observed afresh.
   */
  type SegmentFingerprint = {
    name: string;
    bytes: number;
    mtimeMs: number;
    ino: number;
  };

  type TurnsGenerationCache = {
    segments: SegmentFingerprint[];
    base: ParsedLogSegment;
    parsedExtras: ParsedLogSegment[];
    merged: ParsedLogSegment;
  };

  let turnsCache: TurnsGenerationCache | null = null;

  function invalidateTurnsCache(): void {
    turnsCache = null;
  }

  async function turnSegmentStats(): Promise<SegmentFingerprint[]> {
    const listing = new Set(await fs.promises.readdir(dir));
    if (!listing.has(TURNS_FILE)) return [];
    const out: SegmentFingerprint[] = [];
    for (let index = 0; ; index++) {
      const name = segmentFileName(TURNS_FILE, index);
      if (!listing.has(name)) break;
      const stats = await fs.promises.stat(path.join(dir, name));
      out.push({
        name,
        bytes: stats.size,
        mtimeMs: stats.mtimeMs,
        ino: stats.ino,
      });
    }
    return out;
  }

  /** Count of leading segments whose stat still matches the cached parse. */
  function sharedSegmentPrefix(
    cached: SegmentFingerprint[],
    observed: SegmentFingerprint[],
  ): number {
    let count = 0;
    while (count < cached.length && count < observed.length) {
      const before = cached[count];
      const after = observed[count];
      if (
        before === undefined ||
        after === undefined ||
        before.name !== after.name ||
        before.bytes !== after.bytes ||
        before.mtimeMs !== after.mtimeMs ||
        before.ino !== after.ino
      ) {
        break;
      }
      count++;
    }
    return count;
  }

  async function readLiveLogCached(): Promise<ParsedLogSegment> {
    const segments = await turnSegmentStats();
    if (
      turnsCache !== null &&
      turnsCache.segments.length === segments.length &&
      sharedSegmentPrefix(turnsCache.segments, segments) === segments.length
    ) {
      adoptLoggedApprovals(turnsCache.merged.approvals);
      return turnsCache.merged;
    }
    const reused =
      turnsCache === null
        ? 0
        : sharedSegmentPrefix(turnsCache.segments, segments);
    // Base segment stat unchanged: its parse is still exactly what disk
    // holds, so only the newer segments get re-read and re-parsed.
    // Otherwise parse turns.jsonl here rather than through the isogit base's
    // load(): that also validates metadata.json against the vendor shape,
    // which this store no longer writes (tokenUsage lives on the sidecar).
    // Metadata is read separately by readSessionMetadata.
    const baseLog =
      reused >= 1 && turnsCache !== null
        ? turnsCache.base
        : await readBaseLogFromDisk(dir);
    const parsedExtras: ParsedLogSegment[] = [];
    for (let index = 1; index < segments.length; index++) {
      const cached =
        index < reused && turnsCache !== null
          ? turnsCache.parsedExtras[index - 1]
          : undefined;
      if (cached !== undefined) {
        parsedExtras.push(cached);
        continue;
      }
      const segment = segments.at(index);
      if (segment === undefined) continue;
      const text = await fs.promises.readFile(
        path.join(dir, segment.name),
        "utf-8",
      );
      const approvals: PendingOperation[] = [];
      const turns = parseSegmentTurns(
        text,
        index === segments.length - 1,
        segment.name,
        true,
        approvals,
      );
      parsedExtras.push({ turns, approvals });
    }
    const merged = await mergedLiveLog(baseLog, parsedExtras);
    turnsCache = { segments, base: baseLog, parsedExtras, merged };
    adoptLoggedApprovals(merged.approvals);
    return merged;
  }

  async function readLiveTurns(): Promise<ConversationTurn[]> {
    return (await readLiveLogCached()).turns;
  }

  async function resolveFirstWrite(
    turns: readonly ConversationTurn[],
  ): Promise<"append" | "rewrite" | "divert"> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const marker = await readOwnerMarker(dir);
      if (marker !== null && marker.ownerId === ownerToken) {
        const live = await readLiveTurns();
        return contentPrefixLength(live, turns) === live.length
          ? "append"
          : "rewrite";
      }
      if (
        marker !== null &&
        explicitOwnerId !== undefined &&
        marker.ownerId !== ownerToken
      ) {
        return "divert";
      }
      const live = await readLiveTurns();
      if (marker !== null && live.length === 0) return "divert";
      if (
        live.length === 0 ||
        contentPrefixLength(live, turns) === live.length
      ) {
        if (marker === null && !(await tryCreateOwnerMarker(dir, ownerToken))) {
          continue;
        }
        return "append";
      }
      if (isCompactionOf(live, turns)) {
        if (marker === null && !(await tryCreateOwnerMarker(dir, ownerToken))) {
          continue;
        }
        return "rewrite";
      }
      return "divert";
    }
    return "divert";
  }

  async function writeTurnsLiveOrStage(
    turns: readonly ConversationTurn[],
  ): Promise<void> {
    if (unpublishedRewrite !== null) {
      unpublishedRewrite = [...turns];
      return;
    }
    if (liveTurnRefs !== null) {
      if (refPrefixLength(liveTurnRefs, turns) < liveTurnRefs.length) {
        unpublishedRewrite = [...turns];
        return;
      }
      await writeTurnLog(turns);
      liveTurnRefs = [...turns];
      invalidateTurnsCache();
      return;
    }
    await withResolvedDirLock(dir, async () => {
      if (unpublishedRewrite !== null) {
        unpublishedRewrite = [...turns];
        return;
      }
      if (liveTurnRefs !== null) {
        if (refPrefixLength(liveTurnRefs, turns) < liveTurnRefs.length) {
          unpublishedRewrite = [...turns];
          return;
        }
        await writeTurnLog(turns);
        liveTurnRefs = [...turns];
        invalidateTurnsCache();
        return;
      }
      const decision = await resolveFirstWrite(turns);
      if (decision === "divert") {
        divertToVersionedBases();
        unpublishedRewrite = [...turns];
        return;
      }
      if (decision === "rewrite") {
        unpublishedRewrite = [...turns];
        return;
      }
      await writeTurnLog(turns);
      liveTurnRefs = [...turns];
      invalidateTurnsCache();
    });
  }

  // Prefer the longest loadable prefix of base + extras; orphan tails from a
  // fresh-writer compaction rewrite are dropped and unlinked so the next load
  // does not re-poison the session. A dropped segment's records go with it.
  async function mergedLiveLog(
    baseLog: ParsedLogSegment,
    parsedExtras: ParsedLogSegment[],
  ): Promise<ParsedLogSegment> {
    if (parsedExtras.length === 0) return baseLog;
    const keepExtras = longestWellFormedExtraCount(
      baseLog.turns,
      parsedExtras.map((extra) => extra.turns),
    );

    if (keepExtras < parsedExtras.length) {
      // Segment file index for the first extra is 1.
      const removed = await unlinkExtraSegmentsFrom(
        dir,
        keepExtras + 1,
        pendingSegmentPaths,
      );
      log.warn(
        "dropped {removed} orphan turn segment(s) starting at index {fromIndex} (malformed tool sequence when concatenated)",
        { removed, fromIndex: keepExtras + 1 },
      );
      invalidateTurnsCache();
    }

    const kept = [baseLog, ...parsedExtras.slice(0, keepExtras)];
    return {
      turns: kept.flatMap((segment) => segment.turns),
      approvals: kept.flatMap((segment) => segment.approvals),
    };
  }

  const store: ContextStore & AuditStore = {
    // Full-history read: the reactor's initialization contract. Turns come
    // through the shared generation cache (resilient base and extras,
    // orphan-tail heal), so a repeated load within one store generation does
    // not re-parse segments whose stat is unchanged.
    // Metadata stays a fresh read: corrupt metadata.json soft-defaults so
    // resume does not die or wipe pending ops.
    async load() {
      let liveLog: ParsedLogSegment;
      try {
        liveLog = await readLiveLogCached();
      } catch (cause) {
        // Unrecoverable history: rethrow with the file name in the message.
        throw new Error(
          `failed to load ${TURNS_FILE}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          { cause },
        );
      }
      let metadata: SessionMetadata;
      try {
        metadata = await readSessionMetadata(dir);
      } catch (cause) {
        // Unreadable metadata alone must not abort resume when turns are
        // fine: soft-default, the same contract the base load always had.
        log.warn(
          "session metadata unreadable during resilient load; using empty defaults",
          { cause: cause instanceof Error ? cause.message : String(cause) },
        );
        metadata = emptyMetadata();
      }
      // A still-open legacy approval is remembered so the next canonical
      // flush moves it into the log. It is not marked logged, and it is not
      // written back.
      for (const op of scrubPersistedPendingOperations(
        openPendingOperations(liveLog.turns, metadata.pendingOperations).filter(
          (pending) =>
            pending.suspendedCall !== undefined &&
            !approvalRecords.has(pending.correlationId),
        ),
      )) {
        approvalRecords.set(op.correlationId, pendingApprovalRecord(op));
      }
      const { turns } = liveLog;
      return {
        turns,
        ...metadata,
        // Legacy sessions park approvals on metadata.json only; the next
        // commit moves a still-open one into the log next to its call.
        pendingOperations: openPendingOperations(turns, [
          ...liveLog.approvals,
          ...metadata.pendingOperations,
        ]),
      };
    },
    // Buffer is carried only by this store: base.writeMetadata is never
    // called through the wrapper, so base's pendingConnectorState would
    // never land.
    setConnectorState: (state) => {
      connectorStateBuffer = state;
    },
    branch: (name, signal) => base.branch(name, signal),
    log: (limit, signal) => base.log(limit, signal),
    async readAt(hash) {
      // The base store's strict parser knows turns only; the log also holds
      // approval records.
      let baseText: string | null = null;
      try {
        baseText = await blobTextAtCommit(dir, hash, TURNS_FILE, gitCache);
      } catch (cause) {
        if (!isNotFoundError(cause)) throw cause;
      }
      const baseTurns =
        baseText === null ? [] : parseSegmentTurns(baseText, false, TURNS_FILE);
      const extraNames = await turnSegmentNamesAtCommit(dir, hash, gitCache);
      if (extraNames.length === 0) return baseTurns;

      // Historical commits with orphans still in the tree may be malformed;
      // prefer the longest well-formed prefix, with no on-disk effects. The
      // listed segment blobs read concurrently; the commit-time manifest
      // replaces the per-read tree walk.
      let parsedExtras: ConversationTurn[][];
      try {
        parsedExtras = await Promise.all(
          extraNames.map(async (name) =>
            parseSegmentTurns(
              await blobTextAtCommit(dir, hash, name, gitCache),
              false,
              name,
            ),
          ),
        );
      } catch (cause) {
        // A validated name may still be missing from the tree (torn or
        // rewritten manifest); re-derive from the commit tree once before
        // giving up, same degradation as an unreadable manifest blob.
        log.warn(
          "segment manifest at commit {hash} listed an unreadable segment; re-deriving from the commit tree",
          {
            hash,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        );
        const fallbackNames = await extraSegmentNamesAtCommit(
          dir,
          hash,
          gitCache,
        );
        if (fallbackNames.length === 0) return baseTurns;
        parsedExtras = await Promise.all(
          fallbackNames.map(async (name) =>
            parseSegmentTurns(
              await blobTextAtCommit(dir, hash, name, gitCache),
              false,
              name,
            ),
          ),
        );
      }
      const keepExtras = longestWellFormedExtraCount(baseTurns, parsedExtras);
      if (keepExtras === 0) return baseTurns;
      return [...baseTurns, ...parsedExtras.slice(0, keepExtras).flat()];
    },
    readBlob: (key, signal) => base.readBlob(key, signal),
    // load() reads turns.jsonl, never prompt.jsonl. The checkpoint duplicated
    // that history and nothing reads it, same fold as writeResponse. Legacy
    // trees that still hold one keep staging as a vendor root.
    writePrompt: () => Promise.resolve(),
    // CL-10667 fold: response.jsonl duplicated the assistant turn turns.jsonl
    // already carries, and nothing in the repo reads it (grep over src,
    // scripts, e2e, and the vendored packages: write-only). The per-commit
    // re-write plus re-hash went to zero; LEGACY trees that still hold one
    // keep staging as a vendor root.
    writeResponse: () => Promise.resolve(),
    async writeManifest(records, signal) {
      if (records.length === 0) {
        // Empty cycle buffers converge the worktree to no manifest: the removal
        // joins the pending set, one index write carries it at commit, and
        // readManifestHistory reads a missing manifest as no records.
        if (await pathExists(path.join(dir, MANIFEST_FILE))) {
          await fs.promises.unlink(path.join(dir, MANIFEST_FILE));
          pendingSegmentPaths.add(MANIFEST_FILE);
        }
        return;
      }
      await base.writeManifest(records, signal);
    },
    writeTurns: (turns) => writeTurnsLiveOrStage(turns),
    writeMetadata: (metadata) => writeMetadataLive(metadata),
    readManifestHistory: (limit, signal) =>
      base.readManifestHistory(limit, signal),
    async writeBlob(key, bytes, contentType, signal) {
      await base.writeBlob(key, bytes, contentType, signal);
      const filename = `${sanitizeCallId(key)}${blobExtensionFor(contentType)}`;
      pendingBlobFilepaths.add(`${TOOL_OUTPUT_DIR}/${filename}`);
    },
    async commit(options, signal) {
      return withResolvedDirLock(dir, async () => {
        const stagedRewrite = unpublishedRewrite;
        // The staged rewrite lands on the working-tree segments before the git
        // operations below; snapshot them so a failed commit can restore the
        // published generation. The rewrite stays staged so a retry can still
        // publish it.
        const segmentSnapshot =
          stagedRewrite === null
            ? null
            : await snapshotTurnSegments(dir, turnsBaseName);
        // One HEAD resolution per commit. The catch re-resolves on purpose:
        // it must observe HEAD after the commit to detect a landed commit.
        let headWithinLock: Promise<string | null> | undefined;
        const lockedHead = (): Promise<string | null> => {
          headWithinLock ??= headOid(dir, gitCache);
          return headWithinLock;
        };
        const headBefore = stagedRewrite === null ? null : await lockedHead();
        const loggedBefore = new Set(loggedApprovalIds);
        let extraPaths: string[] = [];

        try {
          if (stagedRewrite !== null) {
            await writeTurnLog(stagedRewrite);
            invalidateTurnsCache();
          }
          const listing = await surveyWorktree(dir, turnsBaseName);
          const toAdd: string[] = [];
          const toRemove: string[] = [];

          for (const filepath of [
            ...pendingSegmentPaths,
            ...pendingBlobFilepaths,
          ]) {
            if (await worktreeListingHas(dir, listing, filepath))
              toAdd.push(filepath);
            else toRemove.push(filepath);
          }

          // Disk is the source of truth for which segments stay tracked after a
          // rewrite or heal, even when pendingSegmentPaths was lost. A rewrite,
          // and the first commit of a store that has not yet published, re-add
          // every contiguous segment so that staging matches snapshot/restore.
          // Later commits stage a tracked segment only when its size, mtime, or
          // inode drifted, so an external append is published and an unchanged
          // segment is not re-read. Untracked names are still added.
          const tracked = await listIndexPaths(dir, gitCache);
          const stageUnchanged =
            stagedRewrite !== null || stageEveryContiguousSegment;
          await reconcileSegmentStaging(
            dir,
            turnsBaseName,
            toAdd,
            toRemove,
            listing,
            tracked,
            stageUnchanged,
            publishedSegmentStats,
          );
          await reconcileSegmentStaging(
            dir,
            PROMPT_FILE,
            toAdd,
            toRemove,
            listing,
            tracked,
            stageUnchanged,
            publishedSegmentStats,
          );

          if (listing.top.has(EVIDENCE_ARCHIVE_DIR)) {
            toAdd.push(EVIDENCE_ARCHIVE_DIR);
          }

          // readAt reads this manifest instead of walking the commit tree.
          // Desired content is recomputed from disk truth every commit, so a
          // worktree manifest left behind by a failed commit self-corrects.
          const contiguousTurnNames = contiguousSegmentNamesFromListing(
            listing.top,
            TURNS_FILE,
          );
          const desiredManifest = JSON.stringify({
            turnSegments: contiguousTurnNames.slice(1),
          });
          if (
            listing.top.has(SEGMENT_MANIFEST_FILE) ||
            desiredManifest !== EMPTY_SEGMENT_MANIFEST
          ) {
            const onDiskManifest = await readSegmentManifestText(dir);
            if (onDiskManifest !== desiredManifest) {
              await fs.promises.writeFile(
                path.join(dir, SEGMENT_MANIFEST_FILE),
                desiredManifest,
              );
            }
            toAdd.push(SEGMENT_MANIFEST_FILE);
          }

          // Empty managed checkpoints must not commit or stage session junk
          // (partial.jsonl). Discover extra segments first so a crash that
          // left them untracked cannot skip. A staged unpublished rewrite is
          // still unpublished on disk — skipping would swallow the compact.
          if (stagedRewrite === null) {
            const managedFilepaths = [
              ...VENDOR_COMMIT_ROOT_FILES,
              TOOL_OUTPUT_DIR,
              EVIDENCE_ARCHIVE_DIR,
              ...pendingSegmentPaths,
              ...pendingBlobFilepaths,
              ...toAdd,
              ...toRemove,
            ];
            if (
              !(await managedPathsDiffer(
                dir,
                managedFilepaths,
                gitCache,
                await blobDirectoriesNeedWalk(),
              ))
            ) {
              const [head] = await base.log(1);
              if (head !== undefined) {
                pendingBlobFilepaths.clear();
                pendingSegmentPaths.clear();
                stageEveryContiguousSegment = false;
                await rememberPublishedTree(listing);
                return head;
              }
            }
          }

          const add = extraCommitPaths([...new Set(toAdd)]);
          // extraCommitPaths strips vendor roots: base.commit() adds those
          // that still exist but never removes missing ones, so an unlinked
          // prompt.jsonl must stay in `remove`.
          const remove = [...new Set(toRemove)].filter((p) => !add.includes(p));
          extraPaths = [...new Set([...add, ...remove])];

          // Array `git.add` / `git.remove` each write the index once.
          // Array `remove` is isomorphic-git 1.43.0; array `add` is older.
          // A mid-batch add failure leaves the index unwritten. Only the
          // outer catch calls `resetIndexPaths`.
          if (add.length > 0) {
            await git.add({ ...cachedGit(dir, gitCache), filepath: add });
          }
          if (remove.length > 0) {
            try {
              await git.remove({
                ...cachedGit(dir, gitCache),
                filepath: remove,
              });
            } catch (cause) {
              // `GitIndex.delete` does not throw when a path is absent, so
              // this is an index lock or write. It aborts before the index
              // write. Skip the failing path and write the rest once.
              let unstaged = false;
              if (remove.length > 1) {
                for (let index = 0; index < remove.length; index++) {
                  const rest = remove.filter((_, other) => other !== index);
                  try {
                    await git.remove({
                      ...cachedGit(dir, gitCache),
                      filepath: rest,
                    });
                    unstaged = true;
                    break;
                  } catch {
                    // This omission still aborted before the index write.
                  }
                }
              }
              if (!unstaged) throw cause;
            }
          }
          const committed = await base.commit(options, signal);
          pendingBlobFilepaths.clear();
          pendingSegmentPaths.clear();
          stageEveryContiguousSegment = false;
          await rememberPublishedTree(listing);
          if (stagedRewrite !== null) {
            liveTurnRefs = stagedRewrite;
            unpublishedRewrite = null;
          }
          return committed;
        } catch (cause) {
          await resetIndexPaths(dir, extraPaths, gitCache);
          if (segmentSnapshot !== null) {
            // Restore the published generation unless the commit actually
            // landed despite throwing (a ref write or post-commit check can
            // fail after HEAD moved), in which case the on-disk rewrite
            // already matches HEAD.
            const headNow = await headOid(dir, gitCache);
            const landed =
              headBefore !== null && headNow !== null && headNow !== headBefore;
            if (!landed) {
              try {
                await restoreTurnSegments(dir, segmentSnapshot, turnsBaseName);
              } catch {
                // A partial restore must not mask the real commit error.
              }
              // Records only the rewrite carried are not canonical until a
              // rewrite lands. Approvals already on the published log stay.
              loggedApprovalIds.clear();
              for (const id of loggedBefore) loggedApprovalIds.add(id);
            }
            // Drop the writer's stale in-memory state so a retry rewrites from
            // scratch.
            writeTurnsSegmented = createSegmentedJSONLWriter(
              dir,
              turnsBaseName,
            );
            liveTurnRefs = null;
            canonicalLines = null;
            // The restore rewrote the published generation; the cached
            // live-turns parse predates it in general, so rebuild from disk.
            invalidateTurnsCache();
          }
          throw cause;
        }
      });
    },
    commitAudit: (records, signal) =>
      withResolvedDirLock(dir, () => base.commitAudit(records, signal)),
    commitErrors: (records, signal) =>
      withResolvedDirLock(dir, () => base.commitErrors(records, signal)),
    loadAudit: (sessionId, signal) => base.loadAudit(sessionId, signal),
    loadErrors: (sessionId, signal) => base.loadErrors(sessionId, signal),
  };

  return { storage: store, audit: store };
}

export async function createOptimizedContextStore(
  dir: string,
  opts?: SessionStoreOptions,
): Promise<ContextStore> {
  const { storage } = await createSessionStores(dir, opts);
  return storage;
}
