import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ChangelogEntry = {
  major: number;
  minor: number;
  patch: number;
  content: string;
};

export function entryVersion(entry: ChangelogEntry): string {
  return `${entry.major}.${entry.minor}.${entry.patch}`;
}

/**
 * Parse Keep-a-Changelog version sections from a CHANGELOG.md body.
 * Only `## [x.y.z]` (or unbracketed `## x.y.z`) headers become entries;
 * `## [Unreleased]` and other non-semver headers are skipped.
 */
export function parseChangelogText(content: string): ChangelogEntry[] {
  const lines = content.split("\n");
  const entries: ChangelogEntry[] = [];

  let currentLines: string[] = [];
  let currentVersion: { major: number; minor: number; patch: number } | null = null;

  const flush = (): void => {
    if (currentVersion !== null && currentLines.length > 0) {
      entries.push({
        ...currentVersion,
        content: currentLines.join("\n").trim(),
      });
    }
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
      if (versionMatch !== null) {
        currentVersion = {
          major: Number.parseInt(versionMatch[1]!, 10),
          minor: Number.parseInt(versionMatch[2]!, 10),
          patch: Number.parseInt(versionMatch[3]!, 10),
        };
        currentLines = [line];
      } else {
        currentVersion = null;
        currentLines = [];
      }
    } else if (currentVersion !== null) {
      currentLines.push(line);
    }
  }
  flush();
  return entries;
}

export function parseChangelog(changelogPath: string): ChangelogEntry[] {
  if (!existsSync(changelogPath)) return [];
  try {
    return parseChangelogText(readFileSync(changelogPath, "utf-8"));
  } catch {
    return [];
  }
}

/** -1 if a < b, 0 if equal, 1 if a > b (semver-ish major.minor.patch only). */
export function compareVersions(a: ChangelogEntry, b: ChangelogEntry): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function parseVersionString(version: string): ChangelogEntry | null {
  const match = version.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (match === null) return null;
  return {
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    patch: Number.parseInt(match[3]!, 10),
    content: "",
  };
}

/** Entries strictly newer than lastVersion (newest-first if the file is newest-first). */
export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] {
  const last = parseVersionString(lastVersion);
  if (last === null) return [];
  return entries.filter((entry) => compareVersions(entry, last) > 0);
}

export const DEFAULT_STARTUP_ENTRY_LIMIT = 3;
export const DEFAULT_STARTUP_MARKDOWN_BYTES = 64 * 1024;

export type StartupChangelogResult = {
  markdown: string;
  truncated: boolean;
  versions: string[];
};

/**
 * Bound automatic startup markdown: newest-first, at most `maxEntries` sections,
 * hard cap `maxBytes` with a trailing hint when truncated.
 */
export function formatStartupChangelog(
  entries: ChangelogEntry[],
  opts?: { maxEntries?: number; maxBytes?: number; fullHint?: string },
): StartupChangelogResult {
  const maxEntries = opts?.maxEntries ?? DEFAULT_STARTUP_ENTRY_LIMIT;
  const maxBytes = opts?.maxBytes ?? DEFAULT_STARTUP_MARKDOWN_BYTES;
  const fullHint = opts?.fullHint ?? "Run /changelog full for complete history.";
  const hintBlock = `\n\n_${fullHint}_`;
  const hintBytes = Buffer.byteLength(hintBlock, "utf8");

  const selected = entries.slice(0, maxEntries);
  const versions = selected.map(entryVersion);
  if (selected.length === 0) {
    return { markdown: "", truncated: false, versions };
  }

  let truncated = entries.length > selected.length;
  const bodyBudget = Math.max(32, maxBytes - hintBytes);
  const kept: string[] = [];

  for (const entry of selected) {
    const piece = entry.content;
    const candidate = kept.length === 0 ? piece : `${kept.join("\n\n")}\n\n${piece}`;
    if (Buffer.byteLength(candidate, "utf8") <= bodyBudget) {
      kept.push(piece);
      continue;
    }
    if (kept.length === 0) {
      // Single section larger than the budget: hard-cut the body so the
      // watermark path never dumps unbounded markdown into the banner.
      const raw = Buffer.from(piece, "utf8").subarray(0, bodyBudget).toString("utf8");
      kept.push(raw.replace(/\uFFFD$/, "").trimEnd() + "…");
    }
    truncated = true;
    break;
  }
  if (kept.length < selected.length) truncated = true;

  let markdown = kept.join("\n\n");
  if (truncated) {
    markdown = `${markdown}${hintBlock}`;
  }
  // Final hard cap if hint + body still overshoots (pathological tiny maxBytes).
  if (Buffer.byteLength(markdown, "utf8") > maxBytes) {
    const cut = Buffer.from(markdown, "utf8").subarray(0, maxBytes).toString("utf8");
    markdown = cut.replace(/\uFFFD$/, "").trimEnd();
    truncated = true;
  }
  return { markdown, truncated, versions: kept.length > 0 ? versions.slice(0, kept.length) : versions };
}

export type ChangelogDisplayDecision =
  | { kind: "first_install"; stampVersion: string }
  | { kind: "upgrade"; markdown: string; stampVersion: string; versions: string[] }
  | { kind: "current"; stampVersion?: undefined };

/**
 * Decide what to show on interactive start.
 * - Missing/empty/malformed watermark → first install: stamp package version, no history dump.
 * - New versioned sections after watermark → upgrade notes + stamp package version.
 * - Otherwise quiet.
 */
export function decideStartupChangelog(input: {
  entries: ChangelogEntry[];
  lastChangelogVersion: string | undefined;
  packageVersion: string;
  maxEntries?: number;
  maxBytes?: number;
}): ChangelogDisplayDecision {
  const pkg = parseVersionString(input.packageVersion);
  const stampVersion = pkg !== null ? entryVersion(pkg) : input.packageVersion.trim();

  const last = input.lastChangelogVersion?.trim() ?? "";
  if (last.length === 0 || parseVersionString(last) === null) {
    return { kind: "first_install", stampVersion };
  }

  const newer = getNewEntries(input.entries, last);
  if (newer.length === 0) {
    return { kind: "current" };
  }

  const formatted = formatStartupChangelog(newer, {
    ...(input.maxEntries !== undefined ? { maxEntries: input.maxEntries } : {}),
    ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
  });
  if (formatted.markdown.length === 0) {
    return { kind: "first_install", stampVersion };
  }
  return {
    kind: "upgrade",
    markdown: formatted.markdown,
    stampVersion,
    versions: formatted.versions,
  };
}

/**
 * Resolve CHANGELOG.md for runtime: package root (dev / npm), then next to the
 * executable (binary install), then cwd.
 */
export function resolveChangelogPath(opts?: {
  moduleUrl?: string;
  execPath?: string;
  cwd?: string;
}): string | undefined {
  const candidates: string[] = [];
  const moduleUrl = opts?.moduleUrl ?? import.meta.url;
  try {
    const here = dirname(fileURLToPath(moduleUrl));
    // src/changelog → repo root; dist/changelog → package root
    candidates.push(join(here, "..", "..", "CHANGELOG.md"));
    candidates.push(join(here, "..", "CHANGELOG.md"));
  } catch {
    // ignore
  }
  const execPath = opts?.execPath ?? process.execPath;
  if (execPath.length > 0) {
    candidates.push(join(dirname(execPath), "CHANGELOG.md"));
    candidates.push(join(dirname(execPath), "..", "share", "doc", "corbits", "CHANGELOG.md"));
    candidates.push(join(dirname(execPath), "..", "share", "doc", "corbits-code", "CHANGELOG.md"));
  }
  const cwd = opts?.cwd ?? process.cwd();
  candidates.push(join(cwd, "CHANGELOG.md"));

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return undefined;
}

export function loadStartupChangelogMarkdown(input: {
  lastChangelogVersion: string | undefined;
  packageVersion: string;
  changelogPath?: string;
  maxEntries?: number;
  maxBytes?: number;
}): ChangelogDisplayDecision {
  const path = input.changelogPath ?? resolveChangelogPath();
  const entries = path !== undefined ? parseChangelog(path) : [];
  return decideStartupChangelog({
    entries,
    lastChangelogVersion: input.lastChangelogVersion,
    packageVersion: input.packageVersion,
    ...(input.maxEntries !== undefined ? { maxEntries: input.maxEntries } : {}),
    ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
  });
}
