/**
 * Raw (non-`cat -n`) file reads for apply_patch's Update File leg (CL-6966).
 * Mirrors the error mapping in @intx/tools-posix's read-file.js so failures
 * read the same way `read_file` would report them.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hasCode } from "@intx/types";
import type { CodexReadRawFile } from "./codex-tool-proxies.js";

/** `path` is a workspace-relative path (apply_patch rejects absolute paths). */
export function createCodexReadRawFile(cwd: string): CodexReadRawFile {
  return async (path) => {
    const absolutePath = resolve(cwd, path);
    try {
      const buf = await readFile(absolutePath);
      if (buf.includes(0)) {
        return { content: `refusing to read binary file: ${path}`, isError: true };
      }
      return { content: buf.toString("utf8") };
    } catch (err) {
      if (hasCode(err)) {
        if (err.code === "ENOENT") return { content: `file not found: ${path}`, isError: true };
        if (err.code === "EACCES") return { content: `permission denied: ${path}`, isError: true };
        if (err.code === "EISDIR")
          return { content: `path is a directory: ${path}`, isError: true };
      }
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  };
}
