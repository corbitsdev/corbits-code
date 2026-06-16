import { matchGlob as matchGlobBase } from "../../interchange/packages/tools-posix/src/glob-match.js";

/**
 * Match a relative file path against a glob pattern.
 *
 * Extends the interchange base with brace expansion: `{a,b}` is expanded into
 * separate patterns and the path matches if any alternative matches.
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  const braceMatch = pattern.match(/^(.*)\{([^}]+)\}(.*)$/);
  if (braceMatch) {
    const prefix = braceMatch[1] ?? "";
    const alts = braceMatch[2] ?? "";
    const suffix = braceMatch[3] ?? "";
    return alts.split(",").some((alt) => matchGlob(`${prefix}${alt}${suffix}`, filePath));
  }
  return matchGlobBase(pattern, filePath);
}
