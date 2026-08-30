import fs from "node:fs";
import path from "node:path";
import { type } from "arktype";
import { createIsogitStore } from "@intx/storage-isogit/node";
import {
  ContentBlock,
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
import type { ContextCommit, ContextStore } from "@intx/types/runtime";
import { LOG_NAMESPACE_ROOT } from "../branding.js";

const TURNS_FILE = "turns.jsonl";
const PROMPT_FILE = "prompt.jsonl";
const RESPONSE_FILE = "response.jsonl";
const MANIFEST_FILE = "manifest.jsonl";
const METADATA_FILE = "metadata.json";
const TOOL_OUTPUT_DIR = "tool-output";

const log = getLogger([LOG_NAMESPACE_ROOT, "session", "context-store"]);

export interface CheckpointAuthor {
  name: string;
  email: string;
}

const HARNESS_AUTHOR: CheckpointAuthor = {
  name: "interchange-harness",
  email: "harness@interchange.local",
};

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
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

function blobExtensionFor(contentType: string | undefined): string {
  if (contentType === undefined) return "";
  return BLOB_EXTENSIONS[contentType] ?? "";
}

function sanitizeCallId(callId: string): string {
  if (callId.includes("..") || callId.includes("/")) {
    throw new Error(`callId contains unsafe characters: ${JSON.stringify(callId)}`);
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
    const line = lines[i]!;
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
      throw new Error(`${fileName} has malformed JSON at line ${i + 1}`, { cause });
    }
    const result = ConversationTurnSchema(raw);
    if (result instanceof type.errors) {
      if (skipMalformed) {
        log.warn?.(`skipping unexpected structure at ${fileName} line ${i + 1}`);
        continue;
      }
      throw new Error(`${fileName} has unexpected structure at line ${i + 1}: ${result.summary}`);
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
    log.warn("metadata.json unreadable during resilient load; using empty defaults", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
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
      keepExtras === 0 ? baseTurns : [...baseTurns, ...parsedExtras.slice(0, keepExtras).flat()];
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
export async function loadRecentTurns(dir: string, minTurns: number): Promise<ConversationTurn[]> {
  const segments = await listSegmentFiles(dir, TURNS_FILE);
  if (segments.length === 0) return [];

  const collectedNewestFirst: ConversationTurn[][] = [];
  let total = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    const name = segments[i]!;
    const text = await fs.promises.readFile(path.join(dir, name), "utf-8");
    // Only the active (last) segment can be mid-write; sealed ones are complete.
    // Display-only: skip lines that will not parse rather than losing the whole
    // transcript to one bad line, and name the segment in any error that does
    // escape (CL-5935). Reactor load uses the same skip path for mid-file
    // garbage so resume does not die (CL-7052).
    const turns = parseSegmentTurns(text, i === segments.length - 1, name, true);
    collectedNewestFirst.push(turns);
    total += turns.length;
    if (total >= minTurns) break;
  }

  const turns: ConversationTurn[] = [];
  for (let i = collectedNewestFirst.length - 1; i >= 0; i--)
    turns.push(...collectedNewestFirst[i]!);
  return turns;
}

async function runGit(
  dir: string,
  args: string[],
  author?: CheckpointAuthor,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const proc = Bun.spawn(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...env,
      ...(author === undefined
        ? {}
        : {
            GIT_AUTHOR_NAME: author.name,
            GIT_AUTHOR_EMAIL: author.email,
            GIT_COMMITTER_NAME: author.name,
            GIT_COMMITTER_EMAIL: author.email,
          }),
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout.trimEnd();
}

async function gitConfigGlobal(key: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const proc = Bun.spawn(["git", "config", "--global", "--get", key], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) return null;
  const value = stdout.trim();
  return value.length > 0 ? value : null;
}

// Operator commit-author hooks see a real identity; machines without both
// global user.name and user.email still checkpoint via the harness fallback.
async function resolveCheckpointAuthor(env: NodeJS.ProcessEnv): Promise<CheckpointAuthor> {
  const [name, email] = await Promise.all([
    gitConfigGlobal("user.name", env),
    gitConfigGlobal("user.email", env),
  ]);
  if (name === null || email === null) return HARNESS_AUTHOR;
  return { name, email };
}

/**
 * Names of the tail turn segments (`turns-0001.jsonl`, ...) present in a commit
 * tree, in segment order. The base store reads the zeroth segment itself; these
 * are the segments it does not know about.
 */
async function extraSegmentNamesAtCommit(dir: string, hash: string): Promise<string[]> {
  const listing = await runGit(dir, ["ls-tree", "--name-only", hash]);
  const present = new Set(listing.split("\n").filter((line) => line.length > 0));
  const names: string[] = [];
  for (let index = 1; ; index++) {
    const name = segmentFileName(TURNS_FILE, index);
    if (!present.has(name)) break;
    names.push(name);
  }
  return names;
}

async function describeHead(dir: string, message: string): Promise<ContextCommit> {
  const [hash, seconds, parents] = (await runGit(dir, ["log", "-1", "--format=%H%n%ct%n%P"])).split(
    "\n",
  );
  if (hash === undefined || hash.length === 0 || seconds === undefined) {
    throw new Error("Unexpected log state after commit: no HEAD");
  }
  const parentHash = parents?.split(" ")[0];
  const base = { hash, message: message.trimEnd(), timestamp: Number(seconds) * 1000 };
  return parentHash !== undefined && parentHash.length > 0 ? { ...base, parentHash } : base;
}

/**
 * Stage every contiguous on-disk segment for `baseName` and `git rm` any
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

  for (let index = startIndex; ; index++) {
    const name = segmentFileName(baseName, index);
    const full = path.join(dir, name);
    if (await pathExists(full)) {
      // Gapped or post-contiguous stray — not part of the live history.
      await fs.promises.unlink(full);
      toRemove.push(name);
      continue;
    }
    const tracked = await runGit(dir, ["ls-files", "--", name]);
    if (tracked.length === 0) {
      if (index > highestDisk) break;
      continue;
    }
    toRemove.push(name);
  }
}

/**
 * Local wrapper around the Interchange git store that avoids O(session length)
 * work per reactor checkpoint. Turns and prompt snapshots are written as rolling
 * segment files so `git add` re-hashes only the small active segment, and only
 * spilled tool-output blobs that are new since the last commit are staged.
 */
export async function createOptimizedContextStore(
  dir: string,
  opts?: { author?: CheckpointAuthor; env?: NodeJS.ProcessEnv },
): Promise<ContextStore> {
  const gitEnv = opts?.env ?? process.env;
  const author = opts?.author ?? (await resolveCheckpointAuthor(gitEnv));
  const base = await createIsogitStore(dir);
  const pendingBlobFilepaths = new Set<string>();
  const pendingSegmentPaths = new Set<string>();
  const writeTurnsSegmented = createSegmentedJSONLWriter(dir, TURNS_FILE);
  const writePromptSegmented = createSegmentedJSONLWriter(dir, PROMPT_FILE);

  async function writeSegmented(
    writer: ReturnType<typeof createSegmentedJSONLWriter>,
    turns: readonly ConversationTurn[],
  ): Promise<void> {
    const { modifiedPaths } = await writer(turns);
    for (const filepath of modifiedPaths) pendingSegmentPaths.add(filepath);
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
      const removed = await unlinkExtraSegmentsFrom(dir, keepExtras + 1, pendingSegmentPaths);
      log.warn(
        "dropped {removed} orphan turn segment(s) starting at index {fromIndex} (malformed tool sequence when concatenated)",
        { removed, fromIndex: keepExtras + 1 },
      );
    }

    if (keepExtras === 0) return baseTurns;
    return [...baseTurns, ...parsedExtras.slice(0, keepExtras).flat()];
  }

  return {
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
        const turns = await loadTurnsWithoutMalformedToolSequence(baseResult.turns, extraTexts);
        return { ...baseResult, turns };
      } catch (cause) {
        log.warn("base context store load failed; recovering turns from disk segments", {
          cause: cause instanceof Error ? cause.message : String(cause),
        });
        let baseTurns: ConversationTurn[];
        try {
          // Prefer resilient parse of segment 0 alone so orphan-tail heal still runs.
          // skipMalformed: mid-file garbage/interleaved records must not kill resume
          // (CL-7052); null-pad stripping and torn-tail drop still apply.
          const basePath = path.join(dir, TURNS_FILE);
          if (await pathExists(basePath)) {
            const text = await fs.promises.readFile(basePath, "utf-8");
            baseTurns = parseSegmentTurns(text, true, TURNS_FILE, true);
          } else {
            baseTurns = [];
          }
        } catch (parseCause) {
          // Unrecoverable: rethrow with the file name in the message.
          throw new Error(
            `failed to load ${TURNS_FILE}: ${
              parseCause instanceof Error ? parseCause.message : String(parseCause)
            }`,
            { cause: parseCause },
          );
        }
        const extraTexts = await readExtraSegmentTexts(dir, TURNS_FILE);
        const turns =
          extraTexts.length === 0
            ? baseTurns
            : await loadTurnsWithoutMalformedToolSequence(baseTurns, extraTexts);
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
        const text = await runGit(dir, ["show", `${hash}:${name}`]);
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
    writeTurns: (turns) => writeSegmented(writeTurnsSegmented, turns),
    writeMetadata: (metadata, signal) => base.writeMetadata(metadata, signal),
    readManifestHistory: (limit, signal) => base.readManifestHistory(limit, signal),
    async writeBlob(key, bytes, contentType, signal) {
      await base.writeBlob(key, bytes, contentType, signal);
      const filename = `${sanitizeCallId(key)}${blobExtensionFor(contentType)}`;
      pendingBlobFilepaths.add(`${TOOL_OUTPUT_DIR}/${filename}`);
    },
    async commit(options, _signal) {
      const toAdd: string[] = [];
      const toRemove: string[] = [];

      const rewrittenEachCycle = [RESPONSE_FILE, MANIFEST_FILE, METADATA_FILE];
      for (const filepath of rewrittenEachCycle) {
        if (await pathExists(path.join(dir, filepath))) toAdd.push(filepath);
      }

      for (const filepath of [...pendingSegmentPaths, ...pendingBlobFilepaths]) {
        if (await pathExists(path.join(dir, filepath))) toAdd.push(filepath);
        else toRemove.push(filepath);
      }

      // Disk is source of truth for which turn/prompt segments should remain
      // tracked after a rewrite or heal, even if pendingSegmentPaths was lost.
      await reconcileSegmentStaging(dir, TURNS_FILE, toAdd, toRemove);
      await reconcileSegmentStaging(dir, PROMPT_FILE, toAdd, toRemove);

      const add = [...new Set(toAdd)];
      const remove = [...new Set(toRemove)].filter((p) => !add.includes(p));

      if (add.length > 0) await runGit(dir, ["add", "--", ...add]);
      if (remove.length > 0) {
        await runGit(dir, ["rm", "--cached", "--ignore-unmatch", "--", ...remove]);
      }
      await runGit(
        dir,
        ["commit", "-m", options.message, `--author=${author.name} <${author.email}>`],
        author,
        gitEnv,
      );
      pendingBlobFilepaths.clear();
      pendingSegmentPaths.clear();
      return describeHead(dir, options.message);
    },
  };
}
