import { readFile, opendir, realpath, stat } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { isSensitivePath } from "../plugins/secret-guard-plugin.js";
import { resolveWorkspacePath } from "../permission/path-restriction.js";
import { createWorktreeRootsProvider } from "../permission/worktree-roots.js";
import { mintPathGrant, isPathCoveredByReadGrant, type PathGrant } from "../permission/path-grants.js";

const MAX_MENTION_FILE_BYTES = 200_000;
const MAX_MENTION_TOTAL_BYTES = 400_000;
const MAX_MENTION_COUNT = 5;
const MAX_DIRECTORY_SUMMARY_ENTRIES = 200;
const MAX_DIRECTORY_NAMES = 20;

async function summarizeDir(abs: string): Promise<string> {
  let scanned = 0;
  let files = 0;
  let dirs = 0;
  const dirNames: string[] = [];
  const directory = await opendir(abs).catch(() => null);
  if (directory === null) return "unreadable directory";

  for await (const entry of directory) {
    if (scanned >= MAX_DIRECTORY_SUMMARY_ENTRIES) break;
    scanned++;
    if (entry.isFile()) files++;
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      dirs++;
      if (dirNames.length < MAX_DIRECTORY_NAMES) dirNames.push(`${entry.name}/`);
    }
  }

  const dirList = dirNames.join(", ");
  const parts: string[] = [];
  if (files > 0) parts.push(`${files}${scanned >= MAX_DIRECTORY_SUMMARY_ENTRIES ? "+" : ""} file${files === 1 ? "" : "s"}`);
  if (dirs > 0) parts.push(`${dirs}${scanned >= MAX_DIRECTORY_SUMMARY_ENTRIES ? "+" : ""} subdirector${dirs === 1 ? "y" : "ies"}${dirList ? ` (${dirList})` : ""}`);
  return parts.length > 0 ? parts.join(", ") : "empty directory";
}

export type AtMentionResult = { text: string; grants: PathGrant[] };

export async function resolveAtMentions(
  message: string,
  cwd: string,
  opts?: { existingGrants?: readonly PathGrant[] },
): Promise<AtMentionResult> {
  const pattern = /@("([^"]+)"|(\S+))/g;
  const mentions: Array<{ full: string; path: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(message)) !== null) {
    const path = m[2] ?? m[3] ?? "";
    if (path.length > 0) mentions.push({ full: m[0], path });
  }
  if (mentions.length === 0) return { text: message, grants: [] };

  // Mirrors the permission gate's workspace-boundary check: cwd plus every
  // registered git worktree of this session. Outside-but-grantable paths are
  // handled below via resolveWorkspacePath + grants, NOT pathRestriction.isRestricted
  // (which would hard-deny them before a grant could mint).
  const rootsProvider = createWorktreeRootsProvider(cwd);
  const existingGrants = opts?.existingGrants ?? [];
  const replacements: Array<{ full: string; replacement: string }> = [];
  const newGrants: PathGrant[] = [];
  let totalBytes = 0;

  for (const [index, { full, path }] of mentions.entries()) {
    if (index >= MAX_MENTION_COUNT) {
      replacements.push({ full, replacement: `${full} (blocked: too many @mentions; max ${MAX_MENTION_COUNT})` });
      continue;
    }
    if (path === "~" || path.startsWith("~/")) {
      replacements.push({ full, replacement: `${full} (blocked: home-relative paths are not supported)` });
      continue;
    }
    if (isSensitivePath(path)) {
      replacements.push({ full, replacement: `${full} (blocked: sensitive path)` });
      continue;
    }
    let abs: string;
    try {
      abs = await realpath(isAbsolute(path) ? path : resolve(cwd, path));
    } catch {
      replacements.push({ full, replacement: `${full} (not found)` });
      continue;
    }
    if (isSensitivePath(abs)) {
      replacements.push({ full, replacement: `${full} (blocked: sensitive path)` });
      continue;
    }

    const inWorkspace = resolveWorkspacePath(cwd, path, rootsProvider) !== undefined;
    const alreadyCovered = !inWorkspace && isPathCoveredByReadGrant(abs, existingGrants);
    const needsGrant = !inWorkspace && !alreadyCovered;

    try {
      const info = await stat(abs);
      if (info.isDirectory()) {
        if (needsGrant) newGrants.push(mintPathGrant(abs, "dir"));
        const summary = await summarizeDir(abs);
        replacements.push({ full, replacement: `\`${path}\` (directory - ${summary})` });
        continue;
      }
      if (info.size > MAX_MENTION_FILE_BYTES) {
        replacements.push({ full, replacement: `${full} (blocked: file is too large; max ${MAX_MENTION_FILE_BYTES} bytes)` });
        continue;
      }
      if (totalBytes + info.size > MAX_MENTION_TOTAL_BYTES) {
        replacements.push({ full, replacement: `${full} (blocked: total @mention content is too large; max ${MAX_MENTION_TOTAL_BYTES} bytes)` });
        continue;
      }
      if (needsGrant) newGrants.push(mintPathGrant(abs, "file"));
      const content = await readFile(abs, "utf-8");
      totalBytes += info.size;
      const ext = abs.split(".").pop() ?? "";
      replacements.push({ full, replacement: `\`${path}\`:\n\`\`\`${ext}\n${content}\n\`\`\`` });
    } catch {
      replacements.push({ full, replacement: `${full} (not found)` });
    }
  }

  let text = message;
  for (const { full, replacement } of replacements) {
    text = text.replace(full, () => replacement);
  }
  return { text, grants: newGrants };
}
