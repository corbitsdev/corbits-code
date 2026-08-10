import { basename, relative, resolve, sep } from "node:path";
import { matchesPattern } from "./matcher.js";

/**
 * Director write-path allowlist (authz, not prompt policy).
 * When set on a sub-agent identity, write_file / edit_file / delete_file must
 * target a path matching one of these patterns. Enforced in the permission
 * gate; skipPermissions (yolo) bypasses the whole gate before this runs.
 *
 * Patterns:
 * - bare filename (`PRODUCT.md`) matches that basename at any depth under cwd
 * - relative globs (`docs/*`, `DESIGN.md`) use matchesPattern against the
 *   workspace-relative path
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

  const base = basename(rel);
  for (const pattern of allowlist) {
    if (matchesPattern(rel, pattern)) return true;
    if (matchesPattern(subject, pattern)) return true;
    if (matchesPattern(base, pattern)) return true;
    // Bare filename: match any depth with that exact basename.
    if (!pattern.includes("/") && !pattern.includes("*") && !pattern.includes("?") && base === pattern) {
      return true;
    }
  }
  return false;
}

export function writePathDeniedReason(
  path: string,
  allowlist: readonly string[],
): string {
  return `Write path denied by director authz allowlist (not prompt policy). Allowed: ${allowlist.join(", ")}. Got: ${path || "(empty)"}. auto mode still enforces this; yolo (skipPermissions) bypasses.`;
}
