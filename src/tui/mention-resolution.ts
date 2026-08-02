import { readFile, opendir, realpath, stat } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { isSensitivePath } from "../plugins/secret-guard-plugin.js";
import { createPathRestriction, type PathRestriction } from "../permission/path-restriction.js";
import { createWorktreeRootsProvider } from "../permission/worktrees.js";

const MAX_MENTION_FILE_BYTES = 200_000;
const MAX_MENTION_TOTAL_BYTES = 400_000;
const MAX_MENTION_COUNT = 5;
const MAX_DIRECTORY_SUMMARY_ENTRIES = 200;
const MAX_DIRECTORY_NAMES = 20;

async function resolveMentionPath(
  cwd: string,
  path: string,
  pathRestriction: PathRestriction,
): Promise<{ ok: true; abs: string } | { ok: false; reason: string }> {
  if (path === "~" || path.startsWith("~/")) {
    return { ok: false, reason: "home-relative paths are not supported" };
  }

  let abs: string;
  try {
    abs = await realpath(isAbsolute(path) ? path : resolve(cwd, path));
  } catch {
    return { ok: false, reason: "not found" };
  }

  if (pathRestriction.isRestricted(abs, false)) {
    return { ok: false, reason: "outside workspace" };
  }

  return { ok: true, abs };
}

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

export async function resolveAtMentions(message: string, cwd: string): Promise<string> {
  const pattern = /@("([^"]+)"|(\S+))/g;
  const mentions: Array<{ full: string; path: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(message)) !== null) {
    const path = m[2] ?? m[3] ?? "";
    if (path.length > 0) mentions.push({ full: m[0], path });
  }
  if (mentions.length === 0) return message;

  // Mirrors the permission gate's own containment check (see gate.ts): the
  // gate resolves paths against cwd plus every registered git worktree of
  // this session, so an @mention into a sibling worktree must resolve the
  // same way rather than being wrongly rejected as an escape.
  const pathRestriction = createPathRestriction(cwd, createWorktreeRootsProvider(cwd));
  const replacements: Array<{ full: string; replacement: string }> = [];
  let totalBytes = 0;

  for (const [index, { full, path }] of mentions.entries()) {
    if (index >= MAX_MENTION_COUNT) {
      replacements.push({ full, replacement: `${full} (blocked: too many @mentions; max ${MAX_MENTION_COUNT})` });
      continue;
    }
    if (isSensitivePath(path)) {
      replacements.push({ full, replacement: `${full} (blocked: sensitive path)` });
      continue;
    }
    const resolved = await resolveMentionPath(cwd, path, pathRestriction);
    if (!resolved.ok) {
      replacements.push({ full, replacement: `${full} (blocked: ${resolved.reason})` });
      continue;
    }
    if (isSensitivePath(resolved.abs)) {
      replacements.push({ full, replacement: `${full} (blocked: sensitive path)` });
      continue;
    }
    try {
      const info = await stat(resolved.abs);
      if (info.isDirectory()) {
        const summary = await summarizeDir(resolved.abs);
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
      const content = await readFile(resolved.abs, "utf-8");
      totalBytes += info.size;
      const ext = resolved.abs.split(".").pop() ?? "";
      replacements.push({ full, replacement: `\`${path}\`:\n\`\`\`${ext}\n${content}\n\`\`\`` });
    } catch {
      replacements.push({ full, replacement: `${full} (not found)` });
    }
  }

  let result = message;
  for (const { full, replacement } of replacements) {
    result = result.replace(full, () => replacement);
  }
  return result;
}
