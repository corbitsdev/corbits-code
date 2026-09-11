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
 * Parse conversation turns out of one JSONL segment. A crash can tear the final
 * line of the active (last) segment mid-write; when `tolerateTornTail` is set a
 * final line that fails to parse is dropped rather than aborting the resume.
 *
 * Null bytes (truncate-past-EOF padding from a stale keepBytes write) are stripped
 * so a poisoned segment can still yield its usable turns on resume. Errors name
 * `fileName` when provided so diagnostics point at the on-disk file, not a bare
 * Bun JSON token.
 *
 * `skipMalformed` drops (or partially recovers) a bad line anywhere in the
 * segment and keeps surrounding history. Used by display-only reads
 * (`loadRecentTurns`) and by the reactor's own `load()` recovery path so a
 * mid-file garbage/interleaved record does not kill resume (CL-7052). Earlier
 * CL-5935 kept reactor load strict; killing the session on one bad line was
 * worse than a hole in history.
 *
 * When a crash left a truncated stub glued to the next append (no newline),
 * the line fails as a whole; `recoverTurnFromGluedLine` still salvages a
 * trailing complete turn from that line when one is present.
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
 * Prefer real metadata via the base store schema on recovery. Soft-default only
 * when metadata.json is missing, corrupt, or otherwise unreadable so poisoned
 * turns still resume without wiping pendingOperations / tokenUsage / connectorState.
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

// Mirrors assertWellFormedToolSequence without throwing. Used to choose the
// longest segment prefix the reactor will accept after a load. Unpaired
// trailing tool_calls are allowed; dups and orphan results fail.
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
 * Longest prefix of `[base, ...extras]` whose tool sequence is well-formed.
 * Returns how many extras to keep (0 = base only). Orphan tails left by a
 * compaction rewrite through a fresh writer reintroduce pre-compact tool turns
 * after the compact head; dropping them is how a poisoned session resumes.
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
  // fromSegmentIndex is the first segment file index to drop (1 = turns-0001).
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
 * Read only the tail of the turn history needed to satisfy `minTurns`, walking
 * segments from newest to oldest and stopping as soon as enough turns have
 * accumulated. Older segments are never read. This is for display-only resume
 * paths (e.g. TUI transcript hydration) that only need a recent window; the
 * canonical full-history read stays on `ContextStore.load()` — the reactor's
 * own initialization contract requires the complete turn history, since that
 * is the actual live conversation state, not a bounded view of it.
 *
 * Orphan-tail recovery lives on `load()`, not here: this path must stay
 * O(window) so resume does not re-pay full-history I/O on healthy sessions.
 */
export async function loadRecentTurns(
  dir: string,
  minTurns: number,
): Promise<ConversationTurn[]> {
  const segments = await listSegmentFiles(dir, TURNS_FILE);
  if (segments.length === 0) return [];

  const collectedNewestFirst: ConversationTurn[][] = [];
  let total = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    const name = segments[i];
    if (name === undefined) continue;
    const text = await fs.promises.readFile(path.join(dir, name), "utf-8");
    // Only the active (last) segment can be mid-write; sealed ones are complete.
    // Display-only: skip lines that will not parse rather than losing the whole
    // transcript to one bad line, and name the segment in any error that does
    // escape (CL-5935). Reactor load uses the same skip path for mid-file
    // garbage so resume does not die (CL-7052).
    const turns = parseSegmentTurns(
      text,
      i === segments.length - 1,
      name,
      true,
    );
    collectedNewestFirst.push(turns);
    total += turns.length;
    if (total >= minTurns) break;
  }

  const turns: ConversationTurn[] = [];
  for (let i = collectedNewestFirst.length - 1; i >= 0; i--) {
    const chunk = collectedNewestFirst[i];
    if (chunk !== undefined) turns.push(...chunk);
  }
  return turns;
}

/**
 * Resilient parse of the base turn segment alone (`turns.jsonl`); extra
 * segments are merged by the caller. Mirrors the recovery `load()` applies
 * when the isogit base store hard-fails, so a torn or poisoned base cannot
 * block the write that heals it.
 */
async function readBaseTurnsFromDisk(dir: string): Promise<ConversationTurn[]> {
  const basePath = path.join(dir, TURNS_FILE);
  if (!(await pathExists(basePath))) return [];
  const text = await fs.promises.readFile(basePath, "utf-8");
  return parseSegmentTurns(text, true, TURNS_FILE, true);
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
 * Contents of every turn segment on disk (`turns.jsonl` plus numbered tails,
 * gapped strays included), keyed by relative name. Captured before a staged
 * rewrite lands so a failed commit can put the working tree back on the
 * published generation.
 */
async function snapshotTurnSegments(dir: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const highest = await highestSegmentIndex(dir, TURNS_FILE);
  for (let index = 0; index <= highest; index++) {
    const name = segmentFileName(TURNS_FILE, index);
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
 * unlink any segment the landed rewrite created.
 */
async function restoreTurnSegments(
  dir: string,
  snapshot: ReadonlyMap<string, string>,
): Promise<void> {
  const names = new Set<string>(snapshot.keys());
  const highest = await highestSegmentIndex(dir, TURNS_FILE);
  for (let index = 0; index <= highest; index++) {
    names.add(segmentFileName(TURNS_FILE, index));
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
 * Stage every contiguous on-disk segment for `baseName` and unstage any
 * higher-numbered or gapped segment still on disk or tracked after a rewrite
 * deleted it — even when the in-memory pending set was lost (process died
 * between heal unlink and commit). Gapped strays are unlinked, not re-added.
 */
async function reconcileSegmentStaging(
  dir: string,
  baseName: string,
  toAdd: string[],
  toRemove: string[],
): Promise<void> {
  const contiguous = await listSegmentFiles(dir, baseName);
  for (const name of contiguous) toAdd.push(name);

  // Start past the last contiguous segment. Index 0 is the base name; numbered
  // tails begin at 1. Empty contiguous (no base) still sweeps numbered files.
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

export interface SessionStores {
  storage: ContextStore;
  audit: AuditStore;
}

/**
 * Local wrapper around the Interchange git store that avoids O(session length)
 * work per reactor checkpoint. Turns and prompt snapshots are written as rolling
 * segment files so only the small active extra segment is re-hashed, then
 * `base.commit()` takes the vendor lock, durable commit, signing, and GC.
 */
export async function createSessionStores(
  dir: string,
  opts?: { signer?: CommitSigner },
): Promise<SessionStores> {
  const signer = opts?.signer ?? (await loadOrCreateCommitSigner(dir));
  const base = await createIsogitStore(dir, signer);
  const pendingBlobFilepaths = new Set<string>();
  const pendingSegmentPaths = new Set<string>();
  let writeTurnsSegmented = createSegmentedJSONLWriter(dir, TURNS_FILE);
  const writePromptSegmented = createSegmentedJSONLWriter(dir, PROMPT_FILE);
  let liveTurnRefs: readonly ConversationTurn[] | null = null;
  let unpublishedRewrite: ConversationTurn[] | null = null;

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
    const extraTexts = await readExtraSegmentTexts(dir, TURNS_FILE);
    let baseTurns: ConversationTurn[];
    try {
      baseTurns = (await base.load()).turns;
    } catch (cause) {
      // A torn or poisoned base tail must not block the write that heals it;
      // recover the usable base turns the same way load() does. This also lets
      // a corrupt metadata.json slide — writeTurns only needs the turns.
      log.warn(
        "base context store load failed during writeTurns; recovering base segment from disk",
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
      baseTurns = await readBaseTurnsFromDisk(dir);
    }
    const live =
      extraTexts.length === 0
        ? baseTurns
        : await loadTurnsWithoutMalformedToolSequence(baseTurns, extraTexts);
    if (live.length > 0 && contentPrefixLength(live, turns) < live.length) {
      unpublishedRewrite = [...turns];
      return;
    }
    await writeSegmented(writeTurnsSegmented, turns);
    liveTurnRefs = [...turns];
  }

  // Prefer the longest prefix of base + extras whose tool sequence the reactor
  // will accept. Orphan tails left by a fresh-writer compaction rewrite are
  // dropped and unlinked so the next load does not re-poison the session.
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
    // Full-history read. Called by the reactor during initialization, where
    // the complete turn history is the actual live conversation state, not an
    // optional convenience — callers that only need a recent tail (e.g. TUI
    // resume hydration) should use `loadRecentTurns` instead.
    //
    // When the base isogit store hard-fails (e.g. null-padded or mid-file
    // garbage turns.jsonl), recover usable turns via resilient segment parse
    // and re-read metadata via the base schema (soft-empty only if that fails
    // too) so resume does not die on a bare Bun JSON token or wipe pending ops.
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
          // Prefer resilient parse of segment 0 alone so orphan-tail heal still runs.
          // skipMalformed: mid-file garbage/interleaved records must not kill resume
          // (CL-7052); null-pad stripping and torn-tail drop still apply.
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

      // Historical commits made while orphans remained in the tree may still be
      // malformed. Prefer the longest well-formed prefix; no on-disk side effects.
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
    writePrompt: (turns) => writeSegmented(writePromptSegmented, turns),
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
        const stagedRewrite = unpublishedRewrite;
        // The staged rewrite lands on the working-tree segments before the git
        // operations below; snapshot them so a failed commit can put the files
        // back on the published generation. `unpublishedRewrite` stays staged
        // so a retried commit can still publish it.
        const segmentSnapshot =
          stagedRewrite === null ? null : await snapshotTurnSegments(dir);
        const headBefore = stagedRewrite === null ? null : await headOid(dir);
        let extraPaths: string[] = [];

        try {
          if (stagedRewrite !== null) {
            await writeSegmented(writeTurnsSegmented, stagedRewrite);
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

          // Disk is source of truth for which turn/prompt segments should remain
          // tracked after a rewrite or heal, even if pendingSegmentPaths was lost.
          await reconcileSegmentStaging(dir, TURNS_FILE, toAdd, toRemove);
          await reconcileSegmentStaging(dir, PROMPT_FILE, toAdd, toRemove);

          if (await pathExists(path.join(dir, EVIDENCE_ARCHIVE_DIR))) {
            toAdd.push(EVIDENCE_ARCHIVE_DIR);
          }

          const add = extraCommitPaths([...new Set(toAdd)]);
          const remove = extraCommitPaths([...new Set(toRemove)]).filter(
            (p) => !add.includes(p),
          );
          extraPaths = [...new Set([...add, ...remove])];

          for (const filepath of add) {
            await git.add({ fs, dir, filepath });
          }
          for (const filepath of remove) {
            try {
              await git.remove({ fs, dir, filepath });
            } catch {
              // Already absent from the index.
            }
          }
          const committed = await base.commit(options, signal);
          pendingBlobFilepaths.clear();
          pendingSegmentPaths.clear();
          if (stagedRewrite !== null) {
            liveTurnRefs = stagedRewrite;
            unpublishedRewrite = null;
          }
          return committed;
        } catch (cause) {
          await resetIndexPaths(dir, extraPaths);
          if (segmentSnapshot !== null) {
            // The rewrite already landed on the working-tree segments; restore
            // them so load() keeps serving the published generation — unless
            // the commit actually landed despite throwing (a ref write or
            // post-commit check can fail after HEAD moved), in which case the
            // on-disk rewrite already matches the new HEAD.
            const headNow = await headOid(dir);
            const landed =
              headBefore !== null && headNow !== null && headNow !== headBefore;
            if (!landed) {
              try {
                await restoreTurnSegments(dir, segmentSnapshot);
              } catch {
                // A partial restore must not mask the real commit error.
              }
            }
            // Drop the writer's stale in-memory state so a retry rewrites the
            // staged segments from scratch.
            writeTurnsSegmented = createSegmentedJSONLWriter(dir, TURNS_FILE);
            liveTurnRefs = null;
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
  };

  return { storage: store, audit: store };
}

export async function createOptimizedContextStore(
  dir: string,
  opts?: { signer?: CommitSigner },
): Promise<ContextStore> {
  const { storage } = await createSessionStores(dir, opts);
  return storage;
}
