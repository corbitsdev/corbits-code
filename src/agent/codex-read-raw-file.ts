/**
 * Raw (non-`cat -n`) file reads for apply_patch's Update File leg (CL-6966).
 *
 * `applyOp` calls this directly from outside the posixTools middleware chain
 * — no ToolPlugin ever sees `op.path` here, unlike the write leg which still
 * goes through the full pathEscapePlugin / secretGuardPlugin / authzPlugin /
 * permissionPlugin stack (see buildCorePosixToolPlugins in
 * posix-tool-plugins.ts). `requireRelativePath` in codex-apply-patch.ts only
 * rejects absolute paths — it does nothing about `../` traversal — so this
 * reader must apply the same containment and secret-file checks itself, or
 * an Update File op naming e.g. `../../.env` (with a no-op insertion hunk,
 * which requires no context match) can read a secret and hand it straight to
 * write_file as an exfiltration primitive.
 *
 * Reuses the existing containment and secret-file authorities rather than
 * reimplementing them: `resolveWorkspacePath` (symlink-aware realpath
 * containment, the same function pathEscapePlugin calls) and
 * `isSensitivePathResolved` (the secretGuardPlugin denylist, including the
 * CL-6971 realpath floor). Both are hard denials — the latter has no
 * yolo/allowOutside bypass, matching secretGuardPlugin's own unconditional
 * behavior.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hasCode } from "@intx/types";
import { resolveWorkspacePath } from "../permission/path-restriction.js";
import { createWorktreeRootsProvider } from "../permission/worktree-roots.js";
import { isSensitivePath, isSensitivePathResolved } from "../plugins/secret-guard-plugin.js";
import type { PermissionGate } from "../permission/gate.js";
import type { CodexReadRawFile } from "./codex-tool-proxies.js";

/** `path` is workspace-relative (apply_patch's parser rejects absolute paths). */
export function createCodexReadRawFile(
  cwd: string,
  permissionGate: PermissionGate,
): CodexReadRawFile {
  const rootsProvider = createWorktreeRootsProvider(cwd);
  const allowOutside = (): boolean => permissionGate.getSkipPermissions();

  return async (path) => {
    // Secret-file denylist first, on the raw path — this must hold regardless
    // of containment or yolo, exactly like secretGuardPlugin's hard deny.
    if (isSensitivePath(path)) {
      return {
        content: `Access to sensitive file blocked by policy: ${path}`,
        isError: true,
      };
    }

    const resolved = resolveWorkspacePath(cwd, path, rootsProvider);
    let absolutePath: string;
    if (resolved !== undefined) {
      absolutePath = resolved;
    } else if (allowOutside()) {
      // Mirrors pathEscapePlugin's own allowOutside fallback (yolo mode):
      // lexical absolutize. The realpath floor below still catches symlinks
      // whose innocuous names would otherwise defeat the denylist (CL-6971).
      absolutePath = resolve(cwd, path);
    } else {
      return {
        content: `Path escapes working directory: ${path}`,
        isError: true,
      };
    }

    // Re-check after resolve — and realpath when the allowOutside branch left
    // a symlink unresolved — so a link can name something innocuous while
    // pointing at a sensitive real path.
    if (isSensitivePathResolved(absolutePath)) {
      return {
        content: `Access to sensitive file blocked by policy: ${path}`,
        isError: true,
      };
    }

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
