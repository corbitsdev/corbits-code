import { opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname, basename } from "node:path";

const MAX_SUGGESTIONS = 20;
const MAX_SCANNED_ENTRIES = 2_000;

async function resolveDirectory(
  dir: string,
  cwd: string,
): Promise<string | null> {
  try {
    return await realpath(resolve(cwd, dir));
  } catch {
    return null;
  }
}

// Given a path prefix the user has typed (after @ or in a path field), return
// up to MAX_SUGGESTIONS matching filesystem entries. Directories get a trailing
// / so the user can drill in. Never throws — returns [] on any fs error.
// Home-relative prefixes (`~`, `~/…`) list the operator's home and keep the
// `~/` display form, matching submit-time expandHome in mention-resolution.ts.
export async function listPathSuggestions(
  prefix: string,
  cwd: string,
): Promise<string[]> {
  // `~` alone lists home, mirroring submit-time expandHome("~") -> homedir().
  const homeRelative = prefix === "~" || prefix.startsWith("~/");
  const rest = homeRelative ? (prefix === "~" ? "" : prefix.slice(2)) : prefix;
  const base = homeRelative ? homedir() : cwd;

  try {
    const endsWithSep = homeRelative
      ? rest.endsWith("/") || rest === ""
      : prefix.endsWith("/");
    // A trailing / lists that directory; a slash without one splits into the
    // dir to list and the filter; no slash at all lists cwd with the whole
    // prefix as filter (the `@` alone case, like `ls`).
    const lastSlash = rest.lastIndexOf("/");
    const hasSlash = lastSlash !== -1;
    const dir = endsWithSep ? rest || "." : hasSlash ? dirname(rest) : ".";
    const fragment = endsWithSep ? "" : hasSlash ? basename(rest) : rest;
    const realDir = await resolveDirectory(dir, base);
    if (realDir === null) return [];

    const matched: string[] = [];
    let scanned = 0;
    const directory = await opendir(realDir);
    for await (const entry of directory) {
      if (matched.length >= MAX_SUGGESTIONS) break;
      if (scanned >= MAX_SCANNED_ENTRIES) break;
      scanned++;
      if (fragment !== "" && !entry.name.startsWith(fragment)) continue;

      // Reconstruct the path the user would type: bare fragments are shown
      // relative to cwd (dirPrefix ""), and home-relative results keep the
      // `~/` form so the completion inserts text the submit path expands.
      const innerPrefix = endsWithSep
        ? rest
        : hasSlash
          ? rest.slice(0, rest.length - fragment.length)
          : "";
      const dirPrefix = homeRelative
        ? `~/${innerPrefix}`
        : endsWithSep
          ? prefix
          : innerPrefix;
      matched.push(dirPrefix + entry.name + (entry.isDirectory() ? "/" : ""));
    }

    return matched;
  } catch {
    return [];
  }
}
