import { posix } from "node:path";
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

export function matchesPattern(
  subject: string,
  pattern: string,
  cwd?: string,
): boolean {
  if (isExactEscapedPattern(pattern)) {
    return subject === unescapeExactPattern(pattern);
  }
  if (!directoryGrantAllows(pattern, subject, cwd)) return false;
  return matchPattern(pattern, subject);
}

// Lexically normalize a grant path (POSIX, no fs I/O): collapse `.`, `..`,
// and duplicate slashes. Absolute paths normalize in place; relative paths
// resolve against cwd when one is supplied. Shared by the matcher gate and
// file-scope minting so both sides agree on what a directory grant covers.
export function normalizeGrantPath(path: string, cwd?: string): string {
  if (posix.isAbsolute(path)) return posix.normalize(path);
  if (cwd !== undefined) return posix.normalize(posix.resolve(cwd, path));
  return posix.normalize(path);
}

// Containment gate for Directory Always grants (`<dir>/*`): the package `*`
// matches `..` lexically, so `/proj/sub/../evil` would otherwise match
// `/proj/sub/*` and escape the granted directory. A normalized subject must
// sit strictly under the anchor, or the grant does not cover it — even the
// anchor itself does not match. Returns true for every non-directory pattern
// so those defer to their existing matcher untouched — the gate only ever
// denies, never allows.
export function directoryGrantAllows(
  pattern: string,
  subject: string,
  cwd?: string,
): boolean {
  if (pattern.includes("\\")) return true;
  if (!pattern.endsWith("/*")) return true;
  const anchor = pattern.slice(0, -2);
  if (anchor.includes("*") || anchor.includes("?")) return true;
  const base = anchor === "" ? "/" : anchor;
  const normalizedAnchor = stripTrailingSlash(normalizeGrantPath(base, cwd));
  const normalizedSubject = stripTrailingSlash(
    normalizeGrantPath(subject, cwd),
  );
  const prefix = normalizedAnchor === "/" ? "/" : `${normalizedAnchor}/`;
  return normalizedSubject.startsWith(prefix);
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}
