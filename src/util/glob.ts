// Glob matching for relative file paths. The single-segment matcher mirrors
// interchange's @intx/tools-posix glob-match; it is reimplemented here rather
// than imported across the submodule source boundary (that import pulls files
// outside this package's rootDir and breaks the type build). This wrapper adds
// brace expansion (`{a,b}`) on top, which the base matcher intentionally rejects.

function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;

  while (i < pattern.length) {
    const c = pattern.charAt(i);

    if (c === "*" && pattern[i + 1] === "*") {
      // `**` -- match zero or more path segments
      i += 2;
      if (pattern[i] === "/") {
        i++; // consume trailing slash after **
        regex += "(?:.+/)?";
      } else {
        regex += ".*";
      }
    } else if (c === "*") {
      regex += "[^/]*";
      i++;
    } else if (c === "?") {
      regex += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(c)) {
      regex += "\\" + c;
      i++;
    } else {
      regex += c;
      i++;
    }
  }

  return new RegExp("^" + regex + "$");
}

/**
 * Match a relative file path against a glob pattern.
 *
 * Supports `**` (any number of segments), `*` (within a segment), `?` (single
 * char), and brace expansion: `{a,b}` is expanded into separate patterns and
 * the path matches if any alternative matches.
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  const braceMatch = pattern.match(/^(.*)\{([^}]+)\}(.*)$/);
  if (braceMatch) {
    const [, prefix, alts, suffix] = braceMatch as [string, string, string, string];
    return alts.split(",").some((alt) => matchGlob(`${prefix}${alt}${suffix}`, filePath));
  }
  return globToRegex(pattern).test(filePath);
}
