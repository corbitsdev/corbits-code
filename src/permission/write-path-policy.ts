import { relative, resolve, sep } from "node:path";
import { matchesPattern } from "./matcher.js";

/**
 * Director write-path allowlist (authz, not prompt policy).
 * When set on a sub-agent identity, write_file / edit_file / delete_file must
 * target a path matching one of these patterns. Enforced in the permission
 * gate; skipPermissions (yolo) bypasses the whole gate before this runs.
 *
 * Patterns:
 * - bare filename (`PRODUCT.md`, no `/ * ?`) matches ONLY the workspace-root
 *   file of that exact name — never a nested file sharing the basename.
 *   A bare name is compared to the workspace-relative path, so `docs/PRODUCT.md`
 *   or `vendor/x/PRODUCT.md` does NOT match `PRODUCT.md`.
 * - relative globs (`docs/*`, double-star-then-PRODUCT.md) use matchesPattern
 *   against the workspace-relative path; use a double-star prefix to match a
 *   basename at any depth.
 */
export function matchesWritePathAllowlist(
  subject: string,
  allowlist: readonly string[],
  cwd: string,
): boolean {
  if (allowlist.length === 0) return false;
  if (subject.length === 0) return false;

  const absCwd = resolve(cwd);
  const abs = resolve(cwd, subject);
  let rel = subject;
  if (abs === absCwd) {
    rel = ".";
  } else if (abs.startsWith(absCwd + sep)) {
    rel = abs.slice(absCwd.length + 1);
  } else {
    // Outside cwd — still try pattern match on the raw subject / relative form.
    try {
      rel = relative(absCwd, abs);
    } catch {
      rel = subject;
    }
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
    if (matchesPattern(subject, pattern)) return true;
  }
  return false;
}

export function writePathDeniedReason(
  path: string,
  allowlist: readonly string[],
): string {
  return `Write path denied by director authz allowlist (not prompt policy). Allowed: ${allowlist.join(", ")}. Got: ${path || "(empty)"}. auto mode still enforces this; yolo (skipPermissions) bypasses.`;
}
