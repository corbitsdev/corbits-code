import { resolve, sep } from "node:path";
import { matchesPattern } from "./matcher.js";
import { realpathNearestOr, UNRESOLVABLE } from "./path-restriction.js";

/**
 * Director write-path allowlist (authz, not prompt policy).
 * When set on a sub-agent identity, write_file / edit_file / delete_file must
 * target a path matching one of these patterns. Enforced in the permission
 * gate; skipPermissions (yolo) bypasses the whole gate before this runs.
 *
 * Subject is resolved against cwd before any matching. Any path that resolves
 * OUTSIDE cwd is hard-denied: the raw subject is never matched against a
 * pattern, so traversal strings (e.g. `docs/../src/hack.ts`) cannot fool a
 * `docs/*` glob and absolute paths under a different root never match.
 *
 * Patterns:
 * - bare filename (`PRODUCT.md`, no `/ * ?`) matches ONLY the workspace-root
 *   file of that exact name — never a nested file sharing the basename.
 *   A bare name is compared to the workspace-relative path, so `docs/PRODUCT.md`
 *   or `vendor/x/PRODUCT.md` does NOT match `PRODUCT.md`.
 * - relative globs (`docs/*`, a double-star-prefixed pattern) use matchesPattern
 *   against the workspace-relative path only; use a double-star prefix to
 *   match a basename at any depth.
 */
export function matchesWritePathAllowlist(
  subject: string,
  allowlist: readonly string[],
  cwd: string,
): boolean {
  if (allowlist.length === 0) return false;
  if (subject.length === 0) return false;

  // Canonicalize both sides the same way path-restriction does: a symlinked
  // cwd (e.g. macOS /tmp -> /private/tmp) must not desync from a subject
  // already resolved to its realpath by resolveWorkspacePath, which would
  // otherwise hard-deny a legitimate allowlisted write.
  const absCwd = realpathNearestOr(resolve(cwd));
  const abs = realpathNearestOr(resolve(cwd, subject));
  // Either side unresolvable (dangling symlink/loop component) must hard-deny.
  // Otherwise an unresolvable cwd and an unresolvable subject both collapse to
  // the same sentinel, `abs === absCwd` goes true, rel becomes ".", and a
  // root-matching allowlist pattern spuriously allows.
  if (absCwd === UNRESOLVABLE || abs === UNRESOLVABLE) return false;
  let rel: string;
  if (abs === absCwd) {
    rel = ".";
  } else if (abs.startsWith(absCwd + sep)) {
    rel = abs.slice(absCwd.length + 1);
  } else {
    // Outside cwd — hard-deny. Never fall through to pattern matching on the
    // raw subject, which would let `docs/../src/hack.ts` match `docs/*`.
    return false;
  }

  for (const pattern of allowlist) {
    // Bare filename (no path separators, no glob metacharacters): root-only.
    // Matching on the basename would re-open any-depth matching for bare names,
    // so a bare pattern is compared only against the workspace-relative path.
    const isBareName =
      !pattern.includes("/") && !pattern.includes("*") && !pattern.includes("?");
    if (isBareName) {
      if (rel === pattern) return true;
      continue;
    }
    if (matchesPattern(rel, pattern)) return true;
  }
  return false;
}

export function writePathDeniedReason(
  path: string,
  allowlist: readonly string[],
): string {
  return `Write path denied by director authz allowlist (not prompt policy). Allowed: ${allowlist.join(", ")}. Got: ${path || "(empty)"}. auto mode still enforces this; yolo (skipPermissions) bypasses.`;
}
