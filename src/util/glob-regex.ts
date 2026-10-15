// Glob and user-regex patterns are accepted by several search surfaces; the
// translation rules and the "invalid regex" denial live in one place so the
// behavior cannot drift between them. Caller-specific semantics (e.g. brace
// expansion rejection) stay with the caller.

// Cut the escaped set at `$`: no multiline/end anchors inside a single path
// token, and the wrap below anchors both ends itself.
const REGEX_SPECIALS = ".+^${}()|[]\\";

/** One glob segment language -> anchored RegExp (`*` stops at `/`, `**` does not). */
export function globToRegExp(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern.charAt(i);
    if (c === "*" && pattern[i + 1] === "*") {
      i += 2;
      if (pattern[i] === "/") {
        i++;
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
    } else if (REGEX_SPECIALS.includes(c)) {
      regex += `\\${c}`;
      i++;
    } else {
      regex += c;
      i++;
    }
  }
  return new RegExp(`^${regex}$`);
}

/** Compile a model-supplied regex, turning a bad pattern into the shared denial. */
export function compileUserRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (err) {
    throw new Error(
      `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
