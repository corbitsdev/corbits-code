import { lstatSync, statSync, type Stats } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

// lstat results for one synchronous containment check (or one shell cwd
// resolve plus its usability stat). A resolved real path is never stored:
// the next tool call must walk again, because a symlink target can move
// without changing the link text or the leaf inode.
let depth = 0;
let lstatMemo: Map<string, LstatMemoEntry> | undefined;

type LstatMemoEntry = {
  stats: Stats | undefined;
  code: string | undefined;
};

export function enterPathResolution<T>(fn: () => T): T {
  const top = depth === 0;
  if (top) lstatMemo = new Map();
  depth++;
  try {
    return fn();
  } finally {
    depth--;
    if (top) lstatMemo = undefined;
  }
}

function hasDotSegment(path: string): boolean {
  for (const segment of path.split(sep)) {
    if (segment === "." || segment === "..") return true;
  }
  return false;
}

function cacheKey(path: string): string {
  // path.resolve drops `.` and `..`, so a successful lstat of `sub/dang` would
  // be reused for `sub/dang/.`. That path is not the symlink: readlink of the
  // dotted form throws, and a failed lstat of it must not be stored as absence
  // of `sub/dang` either. Absolute paths are already uncollapsed.
  if (!isAbsolute(path) && hasDotSegment(path)) {
    return `${resolve(".")}${sep}${path}`;
  }
  return isAbsolute(path) ? path : resolve(path);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function readLstat(path: string): LstatMemoEntry {
  const key = cacheKey(path);
  const memo = lstatMemo;
  const cached = memo?.get(key);
  if (cached !== undefined) return cached;
  let entry: LstatMemoEntry;
  try {
    entry = { stats: lstatSync(path), code: undefined };
  } catch (error) {
    entry = { stats: undefined, code: errorCode(error) };
  }
  memo?.set(key, entry);
  return entry;
}

export function lstatMemoized(path: string): Stats | undefined {
  return readLstat(path).stats;
}

// `code` is set only when lstat threw. ENOTDIR is not a missing path: the
// component exists but is not a directory (a symlink to a file, then `.` or `..`).
export function lstatFailureCode(path: string): string | undefined {
  const entry = readLstat(path);
  return entry.stats === undefined ? entry.code : undefined;
}

/**
 * Stat a cwd. Inside an open resolution this reuses the lstat already taken
 * for that check when the node is not a symlink; a symlink is still followed.
 * The memo dies with the outermost call, so the next tool call stats again.
 */
export function cachedStatSync(path: string): Stats {
  return enterPathResolution(() => {
    const st = lstatMemoized(path);
    if (st === undefined || st.isSymbolicLink()) return statSync(path);
    return st;
  });
}
