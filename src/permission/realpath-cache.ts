import { lstatSync, statSync, type Stats } from "node:fs";
import { isAbsolute, resolve } from "node:path";

// lstat results for one synchronous containment check (or one shell cwd
// resolve plus its usability stat). A resolved real path is never stored:
// the next tool call must walk again, because a symlink target can move
// without changing the link text or the leaf inode.
let depth = 0;
let lstatMemo: Map<string, Stats | undefined> | undefined;

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

function cacheKey(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

export function lstatMemoized(path: string): Stats | undefined {
  const key = cacheKey(path);
  const memo = lstatMemo;
  if (memo !== undefined && memo.has(key)) return memo.get(key);
  let st: Stats | undefined;
  try {
    st = lstatSync(path);
  } catch {
    st = undefined;
  }
  memo?.set(key, st);
  return st;
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
