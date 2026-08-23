import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import { hasCode } from "@intx/types";

const SKIP_SEGMENTS = new Set(["node_modules", ".git"]);

/** Max file paths considered per search (directory walk). */
export const BOUNDED_GREP_MAX_DIRECTORY_ENTRIES = 25_000;

/** Max bytes read from any single file during content search. */
export const BOUNDED_GREP_MAX_PER_FILE_BYTES = 512_000;

export const BOUNDED_GREP_DEFAULT_MAX_RESULTS = 500;
export const BOUNDED_SEARCH_DEFAULT_MAX_RESULTS = 1000;

export interface BoundedGrepLimits {
  maxDirectoryEntries?: number;
  maxPerFileBytes?: number;
}

export interface BoundedGrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  context?: number;
  max_results?: number;
}

export interface BoundedSearchFilesArgs {
  pattern: string;
  path?: string;
  max_results?: number;
}

interface Match {
  file: string;
  lineNumber: number;
  line: string;
}

interface FileSearchResult {
  matches: Match[];
  lines: string[];
}

function shouldSkip(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.some((s) => SKIP_SEGMENTS.has(s));
}

function globToRegex(pattern: string): RegExp {
  if (/\{[^}]+\}/.test(pattern)) {
    throw new Error(
      `brace expansion is not supported: "${pattern}". Use separate searches or a ** pattern instead.`,
    );
  }

  let regex = "";
  let i = 0;

  while (i < pattern.length) {
    const c = pattern.charAt(i);

    if (c === "*" && pattern[i + 1] === "*") {
      i += 2;
      if (pattern[i] === "/") {
        i++;
        regex += "(?:.+/)?";
      } else {
        regex += ".*";
      }
    } else if (c === "*") {
      regex += "[^/]*";
      i++;
    } else if (c === "?") {
      regex += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(c)) {
      regex += "\\" + c;
      i++;
    } else {
      regex += c;
      i++;
    }
  }

  return new RegExp("^" + regex + "$");
}

function isBinary(buf: Buffer): boolean {
  return buf.includes(0);
}

async function collectFilePaths(
  basePath: string,
  globFilter: RegExp | null,
  signal: AbortSignal,
  maxEntries: number,
): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = [];
  let truncated = false;

  const enqueueDir = async (dirAbs: string, dirRel: string): Promise<void> => {
    signal.throwIfAborted();
    if (truncated) return;

    let entries: Dirent[];
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch (err) {
      if (hasCode(err) && (err.code === "EACCES" || err.code === "ENOENT")) return;
      throw err;
    }

    for (const entry of entries) {
      signal.throwIfAborted();
      if (truncated) return;

      const rel = dirRel.length === 0 ? entry.name : join(dirRel, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_SEGMENTS.has(entry.name)) continue;
        await enqueueDir(join(dirAbs, entry.name), rel);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (shouldSkip(rel)) continue;
      if (globFilter !== null && !globFilter.test(rel)) continue;
      paths.push(join(dirAbs, entry.name));
      if (paths.length >= maxEntries) {
        truncated = true;
        return;
      }
    }
  };

  const info = await stat(basePath);
  if (info.isFile()) {
    const rel = basename(basePath);
    if (!shouldSkip(rel) && (globFilter === null || globFilter.test(rel))) {
      paths.push(basePath);
    }
    return { paths, truncated: false };
  }
  if (!info.isDirectory()) {
    throw new Error(`path is not a file or directory: ${basePath}`);
  }

  await enqueueDir(basePath, "");
  return { paths, truncated };
}

async function searchFile(
  filePath: string,
  displayPath: string,
  regex: RegExp,
  signal: AbortSignal,
  maxPerFileBytes: number,
): Promise<FileSearchResult | null> {
  signal.throwIfAborted();

  let buf: Buffer;
  try {
    const handle = await readFile(filePath, { signal });
    buf = handle.length > maxPerFileBytes ? handle.subarray(0, maxPerFileBytes) : handle;
  } catch (err) {
    if (hasCode(err) && (err.code === "EISDIR" || err.code === "EACCES" || err.code === "ENOENT")) {
      return null;
    }
    throw err;
  }

  if (isBinary(buf)) return null;

  const lines = buf.toString("utf8").split("\n");
  const matches: Match[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (regex.test(line)) {
      matches.push({ file: displayPath, lineNumber: i + 1, line });
    }
  }

  if (matches.length === 0) return null;
  return { matches, lines };
}

function formatMatches(
  matches: Match[],
  contextLines: number,
  fileLines: Map<string, string[]>,
): string {
  if (contextLines === 0) {
    return matches.map((m) => `${m.file}:${m.lineNumber}:${m.line}`).join("\n");
  }

  const groups = new Map<string, Match[]>();
  for (const m of matches) {
    const list = groups.get(m.file) ?? [];
    list.push(m);
    groups.set(m.file, list);
  }

  const parts: string[] = [];
  let firstGroup = true;

  for (const [file, fileMatches] of groups) {
    const lines = fileLines.get(file);
    if (lines === undefined) continue;

    const matchLineNums = new Set(fileMatches.map((m) => m.lineNumber));
    const ranges: { start: number; end: number }[] = [];
    for (const m of fileMatches) {
      const start = Math.max(1, m.lineNumber - contextLines);
      const end = Math.min(lines.length, m.lineNumber + contextLines);
      const prev = ranges[ranges.length - 1];
      if (prev !== undefined && start <= prev.end + 1) {
        prev.end = end;
      } else {
        ranges.push({ start, end });
      }
    }

    for (const [ri, range] of ranges.entries()) {
      if (!firstGroup || ri > 0) parts.push("--");
      firstGroup = false;
      for (let ln = range.start; ln <= range.end; ln++) {
        const lineContent = lines[ln - 1] ?? "";
        const sep = matchLineNums.has(ln) ? ":" : "-";
        parts.push(`${file}${sep}${ln}${sep}${lineContent}`);
      }
    }
  }

  return parts.join("\n");
}

export async function runBoundedGrep(
  args: BoundedGrepArgs,
  signal: AbortSignal,
  baseCwd: string,
  limits: BoundedGrepLimits = {},
): Promise<string> {
  signal.throwIfAborted();

  let regex: RegExp;
  try {
    regex = new RegExp(args.pattern);
  } catch (err) {
    throw new Error(`invalid regex: ${err instanceof Error ? err.message : String(err)}`);
  }

  const maxDirectoryEntries = limits.maxDirectoryEntries ?? BOUNDED_GREP_MAX_DIRECTORY_ENTRIES;
  const maxPerFileBytes = limits.maxPerFileBytes ?? BOUNDED_GREP_MAX_PER_FILE_BYTES;

  const basePath = resolve(baseCwd, args.path ?? ".");
  const contextLines = args.context ?? 0;
  const maxResults = args.max_results ?? BOUNDED_GREP_DEFAULT_MAX_RESULTS;
  const globFilter = args.glob !== undefined ? globToRegex(args.glob) : null;

  let info;
  try {
    info = await stat(basePath);
  } catch (err) {
    if (hasCode(err)) {
      if (err.code === "ENOENT") throw new Error(`path not found: ${basePath}`, { cause: err });
      if (err.code === "EACCES") throw new Error(`permission denied: ${basePath}`, { cause: err });
    }
    throw err;
  }

  const isDir = info.isDirectory();
  const { paths: filePaths, truncated: walkTruncated } = await collectFilePaths(
    basePath,
    globFilter,
    signal,
    maxDirectoryEntries,
  );

  const allMatches: Match[] = [];
  const fileLinesCache = new Map<string, string[]>();
  let totalMatches = 0;

  for (const fp of filePaths) {
    signal.throwIfAborted();

    const displayPath = isDir ? relative(basePath, fp) : fp;
    const result = await searchFile(fp, displayPath, regex, signal, maxPerFileBytes);
    if (result === null) continue;

    totalMatches += result.matches.length;

    for (const m of result.matches) {
      if (allMatches.length < maxResults) allMatches.push(m);
    }

    if (contextLines > 0 && allMatches.length <= maxResults) {
      fileLinesCache.set(displayPath, result.lines);
    }
  }

  if (totalMatches === 0) {
    return `no matches for /${args.pattern}/`;
  }

  let output = formatMatches(allMatches, contextLines, fileLinesCache);
  if (totalMatches > maxResults) {
    output += `\n... (${maxResults} of ${totalMatches} matches shown)`;
  }
  if (walkTruncated) {
    output += `\n... (directory walk capped at ${maxDirectoryEntries} files; narrow path/glob)`;
  }
  return output;
}

export async function runBoundedSearchFiles(
  args: BoundedSearchFilesArgs,
  signal: AbortSignal,
  baseCwd: string,
  limits: BoundedGrepLimits = {},
): Promise<string> {
  signal.throwIfAborted();

  const maxDirectoryEntries = limits.maxDirectoryEntries ?? BOUNDED_GREP_MAX_DIRECTORY_ENTRIES;

  const basePath = resolve(baseCwd, args.path ?? ".");
  const maxResults = args.max_results ?? BOUNDED_SEARCH_DEFAULT_MAX_RESULTS;
  const regex = globToRegex(args.pattern);

  let info;
  try {
    info = await stat(basePath);
  } catch (err) {
    if (hasCode(err)) {
      if (err.code === "ENOENT")
        throw new Error(`directory not found: ${basePath}`, { cause: err });
      if (err.code === "EACCES") throw new Error(`permission denied: ${basePath}`, { cause: err });
    }
    throw err;
  }

  if (!info.isDirectory()) {
    throw new Error(`path is not a directory: ${basePath}`);
  }

  const { paths: filePaths, truncated: walkTruncated } = await collectFilePaths(
    basePath,
    null,
    signal,
    maxDirectoryEntries,
  );

  const matches: string[] = [];
  let totalMatches = 0;

  for (const fp of filePaths) {
    signal.throwIfAborted();
    const rel = relative(basePath, fp);
    if (!regex.test(rel)) continue;
    totalMatches++;
    if (matches.length < maxResults) matches.push(rel);
  }

  if (totalMatches === 0) {
    return `no files matching "${args.pattern}"`;
  }

  let result = matches.join("\n");
  if (totalMatches > maxResults) {
    result += `\n... (${maxResults} of ${totalMatches} matches shown)`;
  }
  if (walkTruncated) {
    result += `\n... (directory walk capped at ${maxDirectoryEntries} files; narrow path/glob)`;
  }
  return result;
}
