import { matchPattern } from "@intx/authz";

// Exact-command grants (see escapeGlobLiteral) store a backslash before every
// glob metacharacter so a command like `rm -rf build/*` never becomes the
// wildcard `rm -rf build/*`. @intx/authz's matchPattern has no escape syntax —
// `*` always wildcards — so escaped patterns are exact-only: strip one level of
// backslash escapes and require string equality. Unescaped patterns use the
// package matcher (* wildcards only; no `?`).
function unescapeExactPattern(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === "\\" && i + 1 < pattern.length) {
      out += pattern[++i] as string;
      continue;
    }
    out += ch;
  }
  return out;
}

function isExactEscapedPattern(pattern: string): boolean {
  return pattern.includes("\\");
}

// Escape a literal string so it matches only itself under matchesPattern, even
// when it contains `*`, `?`, or `\`. Used when a grant must cover an exact
// command rather than a wildcard pattern.
export function escapeGlobLiteral(text: string): string {
  return text.replace(/[\\*?]/g, "\\$&");
}

export function matchesPattern(subject: string, pattern: string): boolean {
  if (isExactEscapedPattern(pattern)) {
    return subject === unescapeExactPattern(pattern);
  }
  return matchPattern(pattern, subject);
}
