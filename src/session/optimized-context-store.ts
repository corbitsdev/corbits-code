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
  type AuditStore,
  type ConnectorThreadState,
  type ConversationTurn,
  type PendingOperation,
  type TokenUsage,
} from "@intx/types/runtime";
import { getLogger } from "@intx/log";
import {
  createSegmentedJSONLWriter,
  highestSegmentIndex,
  listSegmentFiles,
  readExtraSegmentTexts,
  segmentFileName,
} from "./incremental-jsonl.js";
import type { ContextStore } from "@intx/types/runtime";
import { LOG_NAMESPACE_ROOT } from "../branding.js";
import { loadOrCreateCommitSigner } from "./commit-signer.js";
import { withResolvedDirLock } from "./session-dir-lock.js";

const TURNS_FILE = "turns.jsonl";
const PROMPT_FILE = "prompt.jsonl";
const RESPONSE_FILE = "response.jsonl";
const MANIFEST_FILE = "manifest.jsonl";
const METADATA_FILE = "metadata.json";
const TOOL_OUTPUT_DIR = "tool-output";
const EVIDENCE_ARCHIVE_DIR = "evidence-archive";
const OWNER_MARKER_FILE = "session-owner.json";

const log = getLogger([LOG_NAMESPACE_ROOT, "session", "context-store"]);

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

const ConversationTurnSchema = type({
  role: "'user' | 'assistant' | 'system'",
  content: ContentBlock.array(),
  "model?": "string",
  timestamp: "number",
});

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
 * Soft-default metadata only when metadata.json is unreadable, so poisoned
 * turns still resume without wiping pendingOperations / tokenUsage /
 * connectorState.
 */
async function loadMetadataSoft(
  loadMetadata: () => Promise<SessionMetadata>,
): Promise<SessionMetadata> {
  try {
    return await loadMetadata();
  } catch (cause) {
    log.warn(
      "metadata.json unreadable during resilient load; using empty defaults",
      {
        cause: cause instanceof Error ? cause.message : String(cause),
      },
    );
    return emptyMetadata();
  }
}

// Non-throwing mirror of assertWellFormedToolSequence for picking the
// longest loadable segment prefix. Unpaired trailing tool_calls pass; dups
// and orphan results fail.
function toolSequenceIsWellFormed(turns: readonly ConversationTurn[]): boolean {
  const calledIds = new Set<string>();
  const answeredIds = new Set<string>();
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
  baseTurns: ConversationTurn[],
  parsedExtras: ConversationTurn[][],
): number {
  for (let keepExtras = parsedExtras.length; keepExtras >= 0; keepExtras--) {
    const turns =
      keepExtras === 0
        ? baseTurns
        : [...baseTurns, ...parsedExtras.slice(0, keepExtras).flat()];
    if (toolSequenceIsWellFormed(turns)) return keepExtras;
  }
  return 0;
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

/**
 * Resilient parse of `turns.jsonl` alone (extras merged by the caller).
 * Mirrors `load()`'s recovery when the isogit base hard-fails, so a torn or
 * poisoned base cannot block the healing write.
 */
async function readBaseTurnsFromDisk(dir: string): Promise<ConversationTurn[]> {
  const basePath = path.join(dir, TURNS_FILE);
  if (!(await pathExists(basePath))) return [];
  const text = await fs.promises.readFile(basePath, "utf-8");
  return parseSegmentTurns(text, true, TURNS_FILE, true);
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

async function listIndexPaths(dir: string): Promise<Set<string>> {
  return new Set(await git.listFiles({ fs, dir }));
}

async function extraSegmentNamesAtCommit(
  dir: string,
  hash: string,
): Promise<string[]> {
  const listing = await git.listFiles({ fs, dir, ref: hash });
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
): Promise<string> {
  const { blob } = await git.readBlob({ fs, dir, oid: hash, filepath });
  return new TextDecoder().decode(blob);
}

async function resetIndexPaths(
  dir: string,
  filepaths: readonly string[],
): Promise<void> {
  for (const filepath of filepaths) {
    try {
      await git.resetIndex({ fs, dir, filepath });
    } catch {
      // Not in the index; vendor restore already covers its own paths.
    }
  }
}

async function headOid(dir: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, dir, ref: "HEAD" });
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
 * unlinked, not re-added.
 */
async function reconcileSegmentStaging(
  dir: string,
  baseName: string,
  toAdd: string[],
  toRemove: string[],
): Promise<void> {
  const contiguous = await listSegmentFiles(dir, baseName);
  for (const name of contiguous) toAdd.push(name);

  // Index 0 is the base name; numbered tails begin at 1. No base still
  // sweeps numbered files.
  const startIndex = Math.max(contiguous.length, 1);
  const highestDisk = await highestSegmentIndex(dir, baseName);
  const tracked = await listIndexPaths(dir);

  for (let index = startIndex; ; index++) {
    const name = segmentFileName(baseName, index);
    const full = path.join(dir, name);
    if (await pathExists(full)) {
      // Gapped or post-contiguous stray — not part of the live history.
      await fs.promises.unlink(full);
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
 */
async function managedPathsDiffer(
  dir: string,
  filepaths: readonly string[],
): Promise<boolean> {
  if (filepaths.length === 0) return false;
  const matrix = await git.statusMatrix({
    fs,
    dir,
    filepaths: [...filepaths],
  });
  return matrix.some(([, head, workdir]) => head !== workdir);
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

/**
 * Interchange git-store wrapper that avoids O(session length) work per
 * checkpoint: turns and prompts write as rolling segments so only the active
 * one re-hashes; `base.commit()` keeps the vendor lock, durable commit,
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
  const ownerToken = opts?.ownerId ?? globalThis.crypto.randomUUID();
  const explicitOwnerId = opts?.ownerId;
  let turnsBaseName = TURNS_FILE;
  let promptBaseName = PROMPT_FILE;
  let versionedBase: string | null = null;
  let writeTurnsSegmented = createSegmentedJSONLWriter(dir, TURNS_FILE);
  let writePromptSegmented = createSegmentedJSONLWriter(dir, PROMPT_FILE);
  let liveTurnRefs: readonly ConversationTurn[] | null = null;
  let unpublishedRewrite: ConversationTurn[] | null = null;
  let pendingPrompt: ConversationTurn[] | null = null;
  let stagedPrompt: ConversationTurn[] | null = null;

  function divertToVersionedBases(): void {
    if (versionedBase !== null) return;
    versionedBase = versionedBaseName(TURNS_FILE);
    turnsBaseName = versionedBase;
    writeTurnsSegmented = createSegmentedJSONLWriter(dir, turnsBaseName);
    promptBaseName = versionedBaseName(PROMPT_FILE);
    writePromptSegmented = createSegmentedJSONLWriter(dir, promptBaseName);
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
    while (
      prefix < max &&
      JSON.stringify(prev[prefix]) === JSON.stringify(next[prefix])
    ) {
      prefix++;
    }
    return prefix;
  }

  async function writeSegmented(
    writer: ReturnType<typeof createSegmentedJSONLWriter>,
    turns: readonly ConversationTurn[],
  ): Promise<void> {
    const { modifiedPaths } = await writer(turns);
    for (const filepath of modifiedPaths) pendingSegmentPaths.add(filepath);
  }

  async function readLiveTurns(): Promise<ConversationTurn[]> {
    const basePresent = await pathExists(path.join(dir, TURNS_FILE));
    const extraPresent = await pathExists(
      path.join(dir, segmentFileName(TURNS_FILE, 1)),
    );
    if (!basePresent && !extraPresent) return [];
    return loadLiveTurnsFromDisk();
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

  async function queuePrompt(
    turns: readonly ConversationTurn[],
  ): Promise<void> {
    if (versionedBase !== null && liveTurnRefs === null) {
      stagedPrompt = [...turns];
      pendingPrompt = null;
      return;
    }
    if (
      liveTurnRefs === null &&
      unpublishedRewrite === null &&
      versionedBase === null
    ) {
      pendingPrompt = [...turns];
      return;
    }
    await writePromptIfDiffered(turns);
  }

  async function flushPendingPrompt(): Promise<void> {
    if (pendingPrompt === null) return;
    const prompt = pendingPrompt;
    pendingPrompt = null;
    await writePromptIfDiffered(prompt);
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
      await writeSegmented(writeTurnsSegmented, turns);
      liveTurnRefs = [...turns];
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
        await writeSegmented(writeTurnsSegmented, turns);
        liveTurnRefs = [...turns];
        return;
      }
      const decision = await resolveFirstWrite(turns);
      if (decision === "divert") {
        divertToVersionedBases();
        unpublishedRewrite = [...turns];
        if (pendingPrompt !== null) {
          stagedPrompt = pendingPrompt;
          pendingPrompt = null;
        }
        return;
      }
      if (decision === "rewrite") {
        unpublishedRewrite = [...turns];
        await flushPendingPrompt();
        return;
      }
      await writeSegmented(writeTurnsSegmented, turns);
      liveTurnRefs = [...turns];
      await flushPendingPrompt();
    });
  }

  async function loadLiveTurnsFromDisk(): Promise<ConversationTurn[]> {
    const extraTexts = await readExtraSegmentTexts(dir, TURNS_FILE);
    let baseTurns: ConversationTurn[];
    try {
      baseTurns = (await base.load()).turns;
    } catch (cause) {
      // A torn or poisoned base must not block the healing write; recover the
      // usable turns the same way load() does. Corrupt metadata.json also
      // slides — writeTurns only needs the turns.
      log.warn(
        "base context store load failed during writeTurns; recovering base segment from disk",
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
      baseTurns = await readBaseTurnsFromDisk(dir);
    }
    return extraTexts.length === 0
      ? baseTurns
      : await loadTurnsWithoutMalformedToolSequence(baseTurns, extraTexts);
  }

  function promptEqualsLiveTurns(
    live: readonly ConversationTurn[],
    prompt: readonly ConversationTurn[],
  ): boolean {
    if (live.length !== prompt.length) return false;
    for (let index = 0; index < prompt.length; index++) {
      if (live[index] === prompt[index]) continue;
      if (JSON.stringify(live[index]) !== JSON.stringify(prompt[index]))
        return false;
    }
    return true;
  }

  // The reactor checkpoints the prompt every cycle; identical snapshots
  // double disk and re-hash cost for nothing. load() never reads
  // prompt.jsonl, so skipping leaves resume unchanged; differing prompts
  // still write.
  async function writePromptIfDiffered(
    turns: readonly ConversationTurn[],
  ): Promise<void> {
    let live: readonly ConversationTurn[] | null = null;
    if (unpublishedRewrite !== null) live = unpublishedRewrite;
    else if (liveTurnRefs !== null) live = liveTurnRefs;
    else {
      // Fresh instance: recover live turns from disk like
      // writeTurnsLiveOrStage; failure falls through to a normal write so an
      // unreadable baseline cannot drop the snapshot.
      try {
        const extraTexts = await readExtraSegmentTexts(dir, TURNS_FILE);
        let baseTurns: ConversationTurn[];
        try {
          baseTurns = (await base.load()).turns;
        } catch {
          baseTurns = await readBaseTurnsFromDisk(dir);
        }
        live =
          extraTexts.length === 0
            ? baseTurns
            : await loadTurnsWithoutMalformedToolSequence(
                baseTurns,
                extraTexts,
              );
      } catch {
        live = null;
      }
    }
    if (versionedBase !== null && liveTurnRefs === null) {
      // No versioned file before commit; a crash would orphan it.
      return;
    }
    if (live === null || !promptEqualsLiveTurns(live, turns)) {
      // A differing prompt is normal on resume and must not divert.
      await writeSegmented(writePromptSegmented, turns);
      return;
    }
    // Identical: converge disk to no prompt segment so a stale snapshot
    // cannot linger; removals join pendingSegmentPaths for commit staging.
    const highest = await highestSegmentIndex(dir, promptBaseName);
    let removed = false;
    for (let index = 0; index <= highest; index++) {
      const name = segmentFileName(promptBaseName, index);
      if (!(await pathExists(path.join(dir, name)))) continue;
      await fs.promises.unlink(path.join(dir, name));
      pendingSegmentPaths.add(name);
      removed = true;
    }
    if (removed) {
      writePromptSegmented = createSegmentedJSONLWriter(dir, promptBaseName);
    }
  }

  // Prefer the longest loadable prefix of base + extras; orphan tails from a
  // fresh-writer compaction rewrite are dropped and unlinked so the next load
  // does not re-poison the session.
  async function loadTurnsWithoutMalformedToolSequence(
    baseTurns: ConversationTurn[],
    extraTexts: string[],
  ): Promise<ConversationTurn[]> {
    if (extraTexts.length === 0) return baseTurns;

    const parsedExtras = extraTexts.map((text, index) =>
      parseSegmentTurns(
        text,
        index === extraTexts.length - 1,
        segmentFileName(TURNS_FILE, index + 1),
        true,
      ),
    );
    const keepExtras = longestWellFormedExtraCount(baseTurns, parsedExtras);

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
    }

    if (keepExtras === 0) return baseTurns;
    return [...baseTurns, ...parsedExtras.slice(0, keepExtras).flat()];
  }

  const store: ContextStore & AuditStore = {
    // Full-history read: the reactor's initialization contract. When the base
    // isogit store hard-fails (null-padded or mid-file garbage), recover
    // usable turns via resilient segment parse and re-read metadata via the
    // base schema (soft-empty only if that fails too), so resume does not die
    // or wipe pending ops.
    async load(signal) {
      try {
        const baseResult = await base.load(signal);
        const extraTexts = await readExtraSegmentTexts(dir, TURNS_FILE);
        if (extraTexts.length === 0) return baseResult;
        const turns = await loadTurnsWithoutMalformedToolSequence(
          baseResult.turns,
          extraTexts,
        );
        return { ...baseResult, turns };
      } catch (cause) {
        log.warn(
          "base context store load failed; recovering turns from disk segments",
          {
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        );
        let baseTurns: ConversationTurn[];
        try {
          // Parse segment 0 resiliently so orphan-tail heal still runs;
          // mid-file garbage must not kill resume.
          baseTurns = await readBaseTurnsFromDisk(dir);
        } catch (parseCause) {
          // Unrecoverable: rethrow with the file name in the message.
          throw new Error(
            `failed to load ${TURNS_FILE}: ${
              parseCause instanceof Error
                ? parseCause.message
                : String(parseCause)
            }`,
            { cause: parseCause },
          );
        }
        const extraTexts = await readExtraSegmentTexts(dir, TURNS_FILE);
        const turns =
          extraTexts.length === 0
            ? baseTurns
            : await loadTurnsWithoutMalformedToolSequence(
                baseTurns,
                extraTexts,
              );
        const metadata = await loadMetadataSoft(() => base.loadMetadata());
        return { turns, ...metadata };
      }
    },
    setConnectorState: (state) => base.setConnectorState(state),
    branch: (name, signal) => base.branch(name, signal),
    log: (limit, signal) => base.log(limit, signal),
    async readAt(hash, signal) {
      const baseTurns = await base.readAt(hash, signal);
      const extraNames = await extraSegmentNamesAtCommit(dir, hash);
      if (extraNames.length === 0) return baseTurns;

      // Historical commits with orphans still in the tree may be malformed;
      // prefer the longest well-formed prefix, with no on-disk effects.
      const parsedExtras: ConversationTurn[][] = [];
      for (const name of extraNames) {
        const text = await blobTextAtCommit(dir, hash, name);
        parsedExtras.push(parseSegmentTurns(text, false, name));
      }
      const keepExtras = longestWellFormedExtraCount(baseTurns, parsedExtras);
      if (keepExtras === 0) return baseTurns;
      return [...baseTurns, ...parsedExtras.slice(0, keepExtras).flat()];
    },
    readBlob: (key, signal) => base.readBlob(key, signal),
    // Skipped identical snapshots fall back to live turns; load() never reads
    // prompt.jsonl.
    writePrompt: (turns) => queuePrompt(turns),
    writeResponse: (turn, signal) => base.writeResponse(turn, signal),
    writeManifest: (records, signal) => base.writeManifest(records, signal),
    writeTurns: (turns) => writeTurnsLiveOrStage(turns),
    writeMetadata: (metadata, signal) => base.writeMetadata(metadata, signal),
    readManifestHistory: (limit, signal) =>
      base.readManifestHistory(limit, signal),
    async writeBlob(key, bytes, contentType, signal) {
      await base.writeBlob(key, bytes, contentType, signal);
      const filename = `${sanitizeCallId(key)}${blobExtensionFor(contentType)}`;
      pendingBlobFilepaths.add(`${TOOL_OUTPUT_DIR}/${filename}`);
    },
    async commit(options, signal) {
      return withResolvedDirLock(dir, async () => {
        if (
          pendingPrompt !== null &&
          versionedBase === null &&
          unpublishedRewrite === null &&
          liveTurnRefs === null
        ) {
          const marker = await readOwnerMarker(dir);
          if (
            marker !== null &&
            explicitOwnerId !== undefined &&
            marker.ownerId !== ownerToken
          ) {
            divertToVersionedBases();
            stagedPrompt = pendingPrompt;
            pendingPrompt = null;
          } else {
            const prompt = pendingPrompt;
            pendingPrompt = null;
            await writePromptIfDiffered(prompt);
          }
        }

        const stagedRewrite = unpublishedRewrite;
        const promptToPublish = stagedPrompt;
        // The staged rewrite lands on the working-tree segments before the git
        // operations below; snapshot them so a failed commit can restore the
        // published generation. The rewrite stays staged so a retry can still
        // publish it.
        const segmentSnapshot =
          stagedRewrite === null
            ? null
            : await snapshotTurnSegments(dir, turnsBaseName);
        const promptSnapshot =
          promptToPublish === null
            ? null
            : await snapshotTurnSegments(dir, promptBaseName);
        const headBefore =
          stagedRewrite === null && promptToPublish === null
            ? null
            : await headOid(dir);
        let extraPaths: string[] = [];

        try {
          if (stagedRewrite !== null) {
            await writeSegmented(writeTurnsSegmented, stagedRewrite);
          }
          if (promptToPublish !== null) {
            await writeSegmented(writePromptSegmented, promptToPublish);
          }
          const toAdd: string[] = [];
          const toRemove: string[] = [];

          for (const filepath of [
            ...pendingSegmentPaths,
            ...pendingBlobFilepaths,
          ]) {
            if (await pathExists(path.join(dir, filepath)))
              toAdd.push(filepath);
            else toRemove.push(filepath);
          }

          // Disk is the source of truth for which segments stay tracked after a
          // rewrite or heal, even when pendingSegmentPaths was lost.
          await reconcileSegmentStaging(dir, turnsBaseName, toAdd, toRemove);
          await reconcileSegmentStaging(dir, promptBaseName, toAdd, toRemove);

          if (await pathExists(path.join(dir, EVIDENCE_ARCHIVE_DIR))) {
            toAdd.push(EVIDENCE_ARCHIVE_DIR);
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
            if (!(await managedPathsDiffer(dir, managedFilepaths))) {
              const [head] = await base.log(1);
              if (head !== undefined) {
                pendingBlobFilepaths.clear();
                pendingSegmentPaths.clear();
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
            await git.add({ fs, dir, filepath: add });
          }
          if (remove.length > 0) {
            try {
              await git.remove({ fs, dir, filepath: remove });
            } catch (cause) {
              // `GitIndex.delete` does not throw when a path is absent, so
              // this is an index lock or write. It aborts before the index
              // write. Skip the failing path and write the rest once.
              let unstaged = false;
              if (remove.length > 1) {
                for (let index = 0; index < remove.length; index++) {
                  const rest = remove.filter((_, other) => other !== index);
                  try {
                    await git.remove({ fs, dir, filepath: rest });
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
          if (stagedRewrite !== null) {
            liveTurnRefs = stagedRewrite;
            unpublishedRewrite = null;
          }
          if (promptToPublish !== null) stagedPrompt = null;
          return committed;
        } catch (cause) {
          await resetIndexPaths(dir, extraPaths);
          if (segmentSnapshot !== null || promptSnapshot !== null) {
            // Restore the published generation unless the commit actually
            // landed despite throwing (a ref write or post-commit check can
            // fail after HEAD moved), in which case the on-disk rewrite
            // already matches HEAD.
            const headNow = await headOid(dir);
            const landed =
              headBefore !== null && headNow !== null && headNow !== headBefore;
            if (!landed) {
              if (segmentSnapshot !== null) {
                try {
                  await restoreTurnSegments(
                    dir,
                    segmentSnapshot,
                    turnsBaseName,
                  );
                } catch {
                  // A partial restore must not mask the real commit error.
                }
              }
              if (promptSnapshot !== null) {
                try {
                  await restoreTurnSegments(
                    dir,
                    promptSnapshot,
                    promptBaseName,
                  );
                } catch {
                  // A partial restore must not mask the real commit error.
                }
              }
            }
            // Drop the writer's stale in-memory state so a retry rewrites from
            // scratch.
            if (segmentSnapshot !== null) {
              writeTurnsSegmented = createSegmentedJSONLWriter(
                dir,
                turnsBaseName,
              );
              liveTurnRefs = null;
            }
            if (promptSnapshot !== null) {
              writePromptSegmented = createSegmentedJSONLWriter(
                dir,
                promptBaseName,
              );
            }
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
