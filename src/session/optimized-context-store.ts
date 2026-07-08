import fs from "node:fs";
import path from "node:path";
import { createIsogitStore } from "@intx/storage-isogit";
import { createIncrementalJSONLWriter } from "./incremental-jsonl.js";
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
 * Local wrapper around the Interchange git store that avoids re-staging every
 * historical spilled tool-output blob on each reactor checkpoint.
 */
export async function createOptimizedContextStore(dir: string): Promise<ContextStore> {
  const base = await createIsogitStore(dir);
  const pendingBlobFilepaths = new Set<string>();
  // The base store rewrites the full conversation snapshot on every
  // checkpoint, which is O(session length) of synchronous serialization per
  // turn and the dominant long-session stall. These writers serialize only
  // what changed since the last checkpoint.
  const writeTurnsIncremental = createIncrementalJSONLWriter(path.join(dir, TURNS_FILE));
  const writePromptIncremental = createIncrementalJSONLWriter(path.join(dir, PROMPT_FILE));

  return {
    load: (signal) => base.load(signal),
    setConnectorState: (state) => base.setConnectorState(state),
    branch: (name, signal) => base.branch(name, signal),
    log: (limit, signal) => base.log(limit, signal),
    readAt: (hash, signal) => base.readAt(hash, signal),
    readBlob: (key, signal) => base.readBlob(key, signal),
    writePrompt: (turns) => writePromptIncremental(turns),
    writeResponse: (turn, signal) => base.writeResponse(turn, signal),
    writeManifest: (records, signal) => base.writeManifest(records, signal),
    writeTurns: (turns) => writeTurnsIncremental(turns),
    writeMetadata: (metadata, signal) => base.writeMetadata(metadata, signal),
    readManifestHistory: (limit, signal) => base.readManifestHistory(limit, signal),
    async writeBlob(key, bytes, contentType, signal) {
      await base.writeBlob(key, bytes, contentType, signal);
      const filename = `${sanitizeCallId(key)}${blobExtensionFor(contentType)}`;
      pendingBlobFilepaths.add(`${TOOL_OUTPUT_DIR}/${filename}`);
    },
    async commit(options, _signal) {
      const toStage: string[] = [];
      const tracked = [TURNS_FILE, PROMPT_FILE, RESPONSE_FILE, MANIFEST_FILE, METADATA_FILE];
      for (const filepath of tracked) {
        const fullPath = path.join(dir, filepath);
        if (await pathExists(fullPath)) toStage.push(filepath);
      }

      for (const filepath of pendingBlobFilepaths) {
        const fullPath = path.join(dir, filepath);
        if (await pathExists(fullPath)) toStage.push(filepath);
      }

      if (toStage.length > 0) await runGit(dir, ["add", "--", ...toStage]);
      await runGit(dir, ["commit", "-m", options.message, `--author=${AUTHOR.name} <${AUTHOR.email}>`]);
      pendingBlobFilepaths.clear();
      return describeHead(dir, options.message);
    },
  };
}
