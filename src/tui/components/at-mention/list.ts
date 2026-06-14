import { readdir } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";
import { homedir } from "node:os";

const MAX_SUGGESTIONS = 20;

// Expand ~ to the user's home directory.
function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
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
    // If prefix ends with a separator the user is asking to list that dir.
    // Otherwise, split into dir + basename fragment to filter.
    const endsWithSep = prefix.endsWith("/");
    const dir = endsWithSep ? abs : dirname(abs);
    const fragment = endsWithSep ? "" : basename(abs);

    const entries = await readdir(dir, { withFileTypes: true });
    const matched = entries
      .filter((e) => fragment === "" || e.name.startsWith(fragment))
      .slice(0, MAX_SUGGESTIONS);

    return matched.map((e) => {
      // Build the path the user would type: preserve their original prefix style
      // (absolute, home-relative, or cwd-relative) by re-joining from the prefix's
      // directory portion.
      const dirPrefix = endsWithSep ? prefix : prefix.slice(0, prefix.length - fragment.length);
      return dirPrefix + e.name + (e.isDirectory() ? "/" : "");
    });
  } catch {
    return [];
  }
}
