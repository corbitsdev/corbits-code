import { opendir, realpath } from "node:fs/promises";
import { resolve, dirname, basename, relative, sep } from "node:path";

const MAX_SUGGESTIONS = 20;
const MAX_SCANNED_ENTRIES = 200;

async function resolveWorkspaceDirectory(dir: string, cwd: string): Promise<string | null> {
  const abs = resolve(cwd, dir);
  const rel = relative(cwd, abs);
  if (rel.startsWith("..") || rel === ".." || rel.startsWith(sep) || rel.startsWith("/")) return null;

  try {
    const [realAbs, realCwd] = await Promise.all([realpath(abs), realpath(cwd)]);
    const realRel = relative(realCwd, realAbs);
    if (realRel.startsWith("..") || realRel === ".." || realRel.startsWith(sep) || realRel.startsWith("/")) return null;
    return realAbs;
  } catch {
    return null;
  }
}

// Given what the user has typed after @, return up to MAX_SUGGESTIONS matching
// workspace-relative filesystem paths. Directories get a trailing / so the user
// can drill in. Never throws — returns [] on any fs error.
export async function listAtSuggestions(prefix: string, cwd: string): Promise<string[]> {
  if (prefix.startsWith("/") || prefix === "~" || prefix.startsWith("~/")) return [];

  try {
    const endsWithSep = prefix.endsWith("/");
    // When prefix ends with / the user wants to list that directory.
    // When prefix contains a slash but doesn't end with one, split on the last
    // slash: the left side is the dir to list, the right side is the filter.
    // When prefix has NO slash at all (including the empty string), list cwd
    // and use the whole prefix as a filter. This is the `@` alone case which
    // should behave like `ls` in the current directory.
    const lastSlash = prefix.lastIndexOf("/");
    const hasSlash = lastSlash !== -1;
    const dir = endsWithSep ? prefix : hasSlash ? dirname(prefix) : ".";
    const fragment = endsWithSep ? "" : hasSlash ? basename(prefix) : prefix;
    const realDir = await resolveWorkspaceDirectory(dir, cwd);
    if (realDir === null) return [];

    const matched: string[] = [];
    let scanned = 0;
    const directory = await opendir(realDir);
    for await (const entry of directory) {
      if (matched.length >= MAX_SUGGESTIONS) break;
      if (scanned >= MAX_SCANNED_ENTRIES) break;
      scanned++;
      if (fragment !== "" && !entry.name.startsWith(fragment)) continue;

      // Reconstruct the path the user would type. For bare-fragment prefixes
      // (no slash) entries are shown relative to cwd so dirPrefix is "".
      const dirPrefix = endsWithSep ? prefix : hasSlash ? prefix.slice(0, prefix.length - fragment.length) : "";
      matched.push(dirPrefix + entry.name + (entry.isDirectory() ? "/" : ""));
    }

    return matched;
  } catch {
    return [];
  }
}
