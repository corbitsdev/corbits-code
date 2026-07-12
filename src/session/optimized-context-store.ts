import fs from "node:fs";
import path from "node:path";
import { type } from "arktype";
import { createIsogitStore } from "@intx/storage-isogit";
import { ContentBlock, type ConversationTurn } from "@intx/types/runtime";
import {
  createSegmentedJSONLWriter,
  listSegmentFiles,
  readExtraSegmentTexts,
  segmentFileName,
} from "./incremental-jsonl.js";
import type { ContextCommit, ContextStore } from "@intx/types/runtime";

const TURNS_FILE = "turns.jsonl";
const PROMPT_FILE = "prompt.jsonl";
const RESPONSE_FILE = "response.jsonl";
const MANIFEST_FILE = "manifest.jsonl";
const METADATA_FILE = "metadata.json";
const TOOL_OUTPUT_DIR = "tool-output";

const AUTHOR = {
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
 */
function parseSegmentTurns(text: string, tolerateTornTail: boolean): ConversationTurn[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  const turns: ConversationTurn[] = [];
  for (let i = 0; i < lines.length; i++) {
    const isLast = i === lines.length - 1;
    let raw: unknown;
    try {
      raw = JSON.parse(lines[i]!);
    } catch (cause) {
      if (tolerateTornTail && isLast) break;
      throw new Error("turns segment has malformed JSON", { cause });
    }
    const result = ConversationTurnSchema(raw);
    if (result instanceof type.errors) {
      throw new Error(`turns segment has unexpected structure: ${result.summary}`);
    }
    turns.push(result);
  }
  return turns;
}

/**
 * Read only the tail of the turn history needed to satisfy `minTurns`, walking
 * segments from newest to oldest and stopping as soon as enough turns have
 * accumulated. Older segments are never read. This is for display-only resume
 * paths (e.g. TUI transcript hydration) that only need a recent window; the
 * canonical full-history read stays on `ContextStore.load()` — the reactor's
 * own initialization contract requires the complete turn history, since that
 * is the actual live conversation state, not a bounded view of it.
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
    const text = await fs.promises.readFile(path.join(dir, segments[i]!), "utf-8");
    const tolerateTornTail = i === segments.length - 1;
    const turns = parseSegmentTurns(text, tolerateTornTail);
    collectedNewestFirst.push(turns);
    total += turns.length;
    if (total >= minTurns) break;
  }

  const turns: ConversationTurn[] = [];
  for (let i = collectedNewestFirst.length - 1; i >= 0; i--) turns.push(...collectedNewestFirst[i]!);
  return turns;
}

async function runGit(dir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: AUTHOR.name,
      GIT_AUTHOR_EMAIL: AUTHOR.email,
      GIT_COMMITTER_NAME: AUTHOR.name,
      GIT_COMMITTER_EMAIL: AUTHOR.email,
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

async function readExtraSegmentsAtCommit(dir: string, hash: string): Promise<ConversationTurn[]> {
  const turns: ConversationTurn[] = [];
  for (const name of await extraSegmentNamesAtCommit(dir, hash)) {
    const text = await runGit(dir, ["show", `${hash}:${name}`]);
    turns.push(...parseSegmentTurns(text, false));
  }
  return turns;
}

async function describeHead(dir: string, message: string): Promise<ContextCommit> {
  const [hash, seconds, parents] = (
    await runGit(dir, ["log", "-1", "--format=%H%n%ct%n%P"])
  ).split("\n");
  if (hash === undefined || hash.length === 0 || seconds === undefined) {
    throw new Error("Unexpected log state after commit: no HEAD");
  }
  const parentHash = parents?.split(" ")[0];
  const base = { hash, message: message.trimEnd(), timestamp: Number(seconds) * 1000 };
  return parentHash !== undefined && parentHash.length > 0 ? { ...base, parentHash } : base;
}

/**
 * Local wrapper around the Interchange git store that avoids O(session length)
 * work per reactor checkpoint. Turns and prompt snapshots are written as rolling
 * segment files so `git add` re-hashes only the small active segment, and only
 * spilled tool-output blobs that are new since the last commit are staged.
 */
export async function createOptimizedContextStore(dir: string): Promise<ContextStore> {
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

  return {
    // Full-history read. Called by the reactor during initialization, where
    // the complete turn history is the actual live conversation state, not an
    // optional convenience — callers that only need a recent tail (e.g. TUI
    // resume hydration) should use `loadRecentTurns` instead.
    async load(signal) {
      const baseResult = await base.load(signal);
      const extraTexts = await readExtraSegmentTexts(dir, TURNS_FILE);
      if (extraTexts.length === 0) return baseResult;
      const extraTurns: ConversationTurn[] = [];
      extraTexts.forEach((text, index) => {
        extraTurns.push(...parseSegmentTurns(text, index === extraTexts.length - 1));
      });
      return { ...baseResult, turns: [...baseResult.turns, ...extraTurns] };
    },
    setConnectorState: (state) => base.setConnectorState(state),
    branch: (name, signal) => base.branch(name, signal),
    log: (limit, signal) => base.log(limit, signal),
    async readAt(hash, signal) {
      const baseTurns = await base.readAt(hash, signal);
      const extraTurns = await readExtraSegmentsAtCommit(dir, hash);
      return [...baseTurns, ...extraTurns];
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

      if (toAdd.length > 0) await runGit(dir, ["add", "--", ...toAdd]);
      if (toRemove.length > 0) {
        await runGit(dir, ["rm", "--cached", "--ignore-unmatch", "--", ...toRemove]);
      }
      await runGit(dir, ["commit", "-m", options.message, `--author=${AUTHOR.name} <${AUTHOR.email}>`]);
      pendingBlobFilepaths.clear();
      pendingSegmentPaths.clear();
      return describeHead(dir, options.message);
    },
  };
}
