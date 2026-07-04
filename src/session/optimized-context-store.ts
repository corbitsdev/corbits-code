import fs from "node:fs";
import path from "node:path";
import { createIsogitStore } from "@intx/storage-isogit";
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

async function describeHead(dir: string, expectedOid: string, message: string): Promise<ContextCommit> {
  const hash = await runGit(dir, ["rev-parse", "HEAD"]);
  if (hash !== expectedOid) {
    throw new Error(`Unexpected log state after commit: expected ${expectedOid} as HEAD`);
  }
  const timestamp = Number(await runGit(dir, ["show", "-s", "--format=%ct", "HEAD"])) * 1000;
  let parentHash: string | undefined;
  try {
    parentHash = await runGit(dir, ["rev-parse", "HEAD^"]);
  } catch {
    parentHash = undefined;
  }
  const base = { hash, message: message.trimEnd(), timestamp };
  return parentHash !== undefined ? { ...base, parentHash } : base;
}

/**
 * Local wrapper around the Interchange git store that avoids re-staging every
 * historical spilled tool-output blob on each reactor checkpoint.
 */
export async function createOptimizedContextStore(dir: string): Promise<ContextStore> {
  const base = await createIsogitStore(dir);
  const pendingBlobFilepaths = new Set<string>();

  return {
    load: (signal) => base.load(signal),
    setConnectorState: (state) => base.setConnectorState(state),
    branch: (name, signal) => base.branch(name, signal),
    log: (limit, signal) => base.log(limit, signal),
    readAt: (hash, signal) => base.readAt(hash, signal),
    readBlob: (key, signal) => base.readBlob(key, signal),
    writePrompt: (turns, signal) => base.writePrompt(turns, signal),
    writeResponse: (turn, signal) => base.writeResponse(turn, signal),
    writeManifest: (records, signal) => base.writeManifest(records, signal),
    writeTurns: (turns, signal) => base.writeTurns(turns, signal),
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
      const oid = await runGit(dir, ["rev-parse", "HEAD"]);
      pendingBlobFilepaths.clear();
      return describeHead(dir, oid, options.message);
    },
  };
}
