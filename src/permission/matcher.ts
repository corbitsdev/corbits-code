import type { Approval } from "./types.js";

// Translate a shell-style glob (opencode semantics: `*` = zero or more chars,
// `?` = exactly one char, `\x` = literal `x` even when `x` is `*`, `?`, or `\`,
// everything else literal) into an anchored RegExp.
export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === "\\" && i + 1 < pattern.length) {
      const escaped = pattern[++i] as string;
      out += escaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      continue;
    }
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

// Escape a literal string so it matches only itself when interpreted by
// globToRegExp, even when it contains `*`, `?`, or `\`. Used when a grant must
// cover an exact command rather than a pattern.
export function escapeGlobLiteral(text: string): string {
  return text.replace(/[\\*?]/g, "\\$&");
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
