import type { Approval } from "./types.js";

// Translate a shell-style glob (opencode semantics: `*` = zero or more chars,
// `?` = exactly one char, `\` escapes the next char to a literal, everything
// else literal) into an anchored RegExp.
export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  let escaped = false;
  for (const ch of pattern) {
    if (escaped) {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === "*") {
      out += ".*";
    } else if (ch === "?") {
      out += ".";
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  // A trailing lone backslash escapes nothing; keep it literal.
  if (escaped) out += "\\\\";
  out += "$";
  return new RegExp(out);
}

// Escape a literal string so it matches only itself as an approval pattern —
// `*` and `?` lose their wildcard meaning, `\` its escaping meaning.
export function escapeGlob(literal: string): string {
  return literal.replace(/[\\*?]/g, "\\$&");
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
