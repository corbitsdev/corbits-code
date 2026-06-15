import { readdir } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";
import { homedir } from "node:os";

const MAX_SUGGESTIONS = 20;

// Expand ~ to the user's home directory.
function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return homedir() + p.slice(1);
  }
  return p;
}

// Resolve a prefix to an absolute path, relative to cwd when not absolute.
function resolvePath(prefix: string, cwd: string): string {
  const expanded = expandHome(prefix);
  if (expanded.startsWith("/")) return expanded;
  return resolve(cwd, expanded);
}

// Given what the user has typed after @, return up to MAX_SUGGESTIONS matching
// filesystem paths. Absolute paths (/ or ~) are rooted there; bare paths are
// resolved relative to cwd. Directories get a trailing / so the user can drill
// in. Never throws — returns [] on any fs error.
export async function listAtSuggestions(prefix: string, cwd: string): Promise<string[]> {
  try {
    const abs = resolvePath(prefix, cwd);
    const endsWithSep = prefix.endsWith("/");
    // When prefix ends with / the user wants to list that directory.
    // When prefix contains a slash but doesn't end with one, split on the last
    // slash: the left side is the dir to list, the right side is the filter.
    // When prefix has NO slash at all (including the empty string), list cwd
    // and use the whole prefix as a filter — this is the `@` alone case which
    // should behave like `ls` in the current directory.
    const lastSlash = prefix.lastIndexOf("/");
    const hasSlash = lastSlash !== -1;
    const dir = endsWithSep ? abs : hasSlash ? dirname(abs) : cwd;
    const fragment = endsWithSep ? "" : hasSlash ? basename(abs) : prefix;

    const entries = await readdir(dir, { withFileTypes: true });
    const matched = entries
      .filter((e) => fragment === "" || e.name.startsWith(fragment))
      .slice(0, MAX_SUGGESTIONS);

    return matched.map((e) => {
      // Reconstruct the path the user would type. For bare-fragment prefixes
      // (no slash) entries are shown relative to cwd so dirPrefix is "".
      const dirPrefix = endsWithSep ? prefix : hasSlash ? prefix.slice(0, prefix.length - fragment.length) : "";
      return dirPrefix + e.name + (e.isDirectory() ? "/" : "");
    });
  } catch {
    return [];
  }
}
