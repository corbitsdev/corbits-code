import {
  lstatSync,
  readlinkSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

// Cross-call memo for the sandbox path walk. A hit is valid only while the
// leaf's lstat identity still matches AND every ancestor still has the same
// dev/ino (and, when that ancestor is a symlink, the same link text) as when
// the entry was stored. Rename keeps the leaf inode, so a leaf-only key would
// hide a directory swapped for a symlink. Absence is not stored: a path that
// appears between checks must be resolved again. A failed resolve (dangling
// link, loop) is not stored either, so a target that shows up or disappears
// cannot be hidden by an earlier UNRESOLVABLE or real path.
const MAX_ENTRIES = 4096;

type AncestorStamp = {
  path: string;
  dev: number;
  ino: number;
  linkTarget: string | undefined;
};

type NodeEntry = {
  kind: "node";
  dev: number;
  ino: number;
  real: string;
  ancestors: readonly AncestorStamp[];
};

type LinkEntry = {
  kind: "link";
  dev: number;
  ino: number;
  linkTarget: string;
  real: string;
  targetDev: number;
  targetIno: number;
  ancestors: readonly AncestorStamp[];
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

// Strict ancestors of `path`, root included. Undefined when an ancestor
// cannot be stamped, in which case the caller must not cache a real path.
function ancestorStamps(path: string): AncestorStamp[] | undefined {
  const stamps: AncestorStamp[] = [];
  let current = dirname(cacheKey(path));
  if (current === cacheKey(path)) return stamps;
  while (true) {
    const st = lstatMemoized(current);
    if (st === undefined) return undefined;
    let linkTarget: string | undefined;
    if (st.isSymbolicLink()) {
      linkTarget = readlinkMemoized(current);
      if (linkTarget === undefined) return undefined;
    }
    stamps.push({
      path: current,
      dev: st.dev,
      ino: st.ino,
      linkTarget,
    });
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return stamps;
}

function ancestorsMatch(stamps: readonly AncestorStamp[]): boolean {
  for (const stamp of stamps) {
    const st = lstatMemoized(stamp.path);
    if (st === undefined || st.dev !== stamp.dev || st.ino !== stamp.ino) {
      return false;
    }
    if (stamp.linkTarget !== undefined) {
      if (
        !st.isSymbolicLink() ||
        readlinkMemoized(stamp.path) !== stamp.linkTarget
      ) {
        return false;
      }
    } else if (st.isSymbolicLink()) {
      return false;
    }
  }
  return true;
}

export function cachedNodeReal(path: string, st: Stats): string | undefined {
  const key = cacheKey(path);
  const entry = entries.get(key);
  if (entry === undefined || entry.kind !== "node") return undefined;
  if (entry.dev !== st.dev || entry.ino !== st.ino) return undefined;
  if (!ancestorsMatch(entry.ancestors)) return undefined;
  touch(key, entry);
  return entry.real;
}

export function rememberNode(path: string, st: Stats, real: string): void {
  const ancestors = ancestorStamps(path);
  if (ancestors === undefined) return;
  remember(cacheKey(path), {
    kind: "node",
    dev: st.dev,
    ino: st.ino,
    real,
    ancestors,
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
  // Ancestor identity first. lstat of the cached real path follows a new
  // ancestor symlink and can still see the same target inode after a rename.
  if (!ancestorsMatch(entry.ancestors)) return undefined;
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
  const ancestors = ancestorStamps(path);
  if (ancestors === undefined) return;
  remember(cacheKey(path), {
    kind: "link",
    dev: st.dev,
    ino: st.ino,
    linkTarget,
    real,
    targetDev: targetStat.dev,
    targetIno: targetStat.ino,
    ancestors,
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
