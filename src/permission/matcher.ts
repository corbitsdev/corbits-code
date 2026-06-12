import type { Approval } from "./types.js";

// Translate a shell-style glob (opencode semantics: `*` = zero or more chars,
// `?` = exactly one char, everything else literal) into an anchored RegExp.
export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (const ch of pattern) {
    if (ch === "*") {
      out += ".*";
    } else if (ch === "?") {
      out += ".";
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  out += "$";
  return new RegExp(out);
}

export function matchesPattern(subject: string, pattern: string): boolean {
  return globToRegExp(pattern).test(subject);
}

// True when any stored approval for this tool matches the subject. The subject
// is the shell command segment (run_shell) or the file path (write/edit). An
// approval bound to a `providerModel` only matches when `activeProviderModel`
// equals it, so a grant scoped to one model never leaks to another.
export function isApproved(
  tool: string,
  subject: string,
  approvals: readonly Approval[],
  activeProviderModel?: string,
): boolean {
  return approvals.some(
    (a) =>
      a.tool === tool &&
      matchesPattern(subject, a.pattern) &&
      (a.providerModel === undefined || a.providerModel === activeProviderModel),
  );
}
