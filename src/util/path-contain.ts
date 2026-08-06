import { resolve, sep } from "node:path";

/**
 * True when `abs` is the root or a path strictly under it (prefix + separator).
 * Lexical only — callers that need symlink safety must realpath both sides first.
 */
export function pathIsInsideOrEqual(abs: string, root: string): boolean {
  const a = resolve(abs);
  const r = resolve(root);
  if (a === r) return true;
  // Platform separator so win32 paths (C:\foo) do not treat `/` as the only boundary.
  const prefix = r.endsWith(sep) ? r : `${r}${sep}`;
  return a.startsWith(prefix);
}
