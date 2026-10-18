import {
  lstatSync,
  readlinkSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

// Cross-call memo for the sandbox path walk. A hit is valid only while the
// node's lstat identity still matches — and, for a symlink, while the link
// text and the target's identity still match. Absence is not stored: a path
// that appears between checks must be resolved again. A failed resolve
// (dangling link, loop) is not stored either, so a target that shows up or
// disappears cannot be hidden by an earlier UNRESOLVABLE or real path.
// Replacing a symlink allocates a new inode, so the previous entry misses.
const MAX_ENTRIES = 4096;

type NodeEntry = {
  kind: "node";
  dev: number;
  ino: number;
  real: string;
};

type LinkEntry = {
  kind: "link";
  dev: number;
  ino: number;
  linkTarget: string;
  real: string;
  targetDev: number;
  targetIno: number;
};

type Entry = NodeEntry | LinkEntry;

const entries = new Map<string, Entry>();

// One synchronous resolution (a containment check, or a shell cwd resolve
// plus its usability stat) shares lstat/readlink results. The memo dies with
// the outermost call, so the next tool call observes a replaced symlink.
let depth = 0;
let lstatMemo: Map<string, Stats | undefined> | undefined;
let readlinkMemo: Map<string, string | undefined> | undefined;

export function enterPathResolution<T>(fn: () => T): T {
  const top = depth === 0;
  if (top) {
    lstatMemo = new Map();
    readlinkMemo = new Map();
  }
  depth++;
  try {
    return fn();
  } finally {
    depth--;
    if (top) {
      lstatMemo = undefined;
      readlinkMemo = undefined;
    }
  }
}

function cacheKey(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

function remember(key: string, entry: Entry): void {
  entries.delete(key);
  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(key, entry);
}

function touch(key: string, entry: Entry): void {
  entries.delete(key);
  entries.set(key, entry);
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

export function readlinkMemoized(path: string): string | undefined {
  const key = cacheKey(path);
  const memo = readlinkMemo;
  if (memo !== undefined && memo.has(key)) return memo.get(key);
  let target: string | undefined;
  try {
    target = readlinkSync(path);
  } catch {
    target = undefined;
  }
  memo?.set(key, target);
  return target;
}

export function cachedNodeReal(path: string, st: Stats): string | undefined {
  const key = cacheKey(path);
  const entry = entries.get(key);
  if (entry === undefined || entry.kind !== "node") return undefined;
  if (entry.dev !== st.dev || entry.ino !== st.ino) return undefined;
  touch(key, entry);
  return entry.real;
}

export function rememberNode(path: string, st: Stats, real: string): void {
  remember(cacheKey(path), {
    kind: "node",
    dev: st.dev,
    ino: st.ino,
    real,
  });
}

export function cachedLinkReal(
  path: string,
  st: Stats,
  linkTarget: string,
): string | undefined {
  const key = cacheKey(path);
  const entry = entries.get(key);
  if (entry === undefined || entry.kind !== "link") return undefined;
  if (
    entry.dev !== st.dev ||
    entry.ino !== st.ino ||
    entry.linkTarget !== linkTarget
  ) {
    return undefined;
  }
  // The link inode is not enough: deleting the target leaves the symlink in
  // place. Re-lstat only the cached target, not the ancestor chain.
  let targetStat: Stats;
  try {
    targetStat = lstatSync(entry.real);
  } catch {
    return undefined;
  }
  if (
    targetStat.dev !== entry.targetDev ||
    targetStat.ino !== entry.targetIno
  ) {
    return undefined;
  }
  touch(key, entry);
  return entry.real;
}

export function rememberLink(
  path: string,
  st: Stats,
  linkTarget: string,
  real: string,
): void {
  let targetStat: Stats;
  try {
    targetStat = lstatSync(real);
  } catch {
    return;
  }
  remember(cacheKey(path), {
    kind: "link",
    dev: st.dev,
    ino: st.ino,
    linkTarget,
    real,
    targetDev: targetStat.dev,
    targetIno: targetStat.ino,
  });
}

/** `realpathSync`, skipping the ancestor walk when the node is unchanged. */
export function cachedRealpathSync(path: string): string {
  return enterPathResolution(() => {
    const st = lstatMemoized(path);
    if (st !== undefined && !st.isSymbolicLink()) {
      const hit = cachedNodeReal(path, st);
      if (hit !== undefined) return hit;
    }
    if (st !== undefined && st.isSymbolicLink()) {
      const linkTarget = readlinkMemoized(path);
      if (linkTarget !== undefined) {
        const hit = cachedLinkReal(path, st, linkTarget);
        if (hit !== undefined) return hit;
      }
    }
    const real = realpathSync(path);
    if (st !== undefined && !st.isSymbolicLink()) rememberNode(path, st, real);
    if (st !== undefined && st.isSymbolicLink()) {
      const linkTarget = readlinkMemoized(path);
      if (linkTarget !== undefined) rememberLink(path, st, linkTarget, real);
    }
    return real;
  });
}

/**
 * Stat a cwd. Inside an open resolution this reuses the lstat already taken
 * for realpath when the node is not a symlink; a symlink is still followed.
 * A later call outside that resolution stats again, so deletion is visible.
 */
export function cachedStatSync(path: string): Stats {
  return enterPathResolution(() => {
    const st = lstatMemoized(path);
    if (st === undefined || st.isSymbolicLink()) return statSync(path);
    return st;
  });
}
