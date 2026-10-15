import { lstat, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type } from "arktype";
import type { ExtraTool, ToolPlugin } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { resolveWorkspacePath } from "../permission/path-restriction.js";
import type { RootsProvider } from "../permission/worktree-roots.js";
import { hasCode } from "@intx/types";
import { toolInputSchema } from "../util/tool-input-schema.js";
import { formatChangeDiff } from "./change-diff.js";
import { denyResult, resolveAllowOutside } from "./tool-args.js";

const DeleteFileArgs = type({
  path: [
    "string>0",
    "@",
    {
      description:
        "Path to the file to delete, relative to the working directory or absolute",
    },
  ],
});

export const DELETE_FILE_DEFINITION = {
  name: "delete_file",
  description:
    "Delete one file. Returns success when the file is deleted or already absent. Refuses directories; use this instead of shell rm for file deletion.",
  inputSchema: toolInputSchema(DeleteFileArgs),
};

export interface DeleteFilePluginOptions {
  // When true (yolo / --dangerously-skip-permissions), delete outside the
  // working directory. A getter is resolved per call so `/yolo` mid-session
  // takes effect without rebuilding the plugin stack.
  allowOutside?: boolean | (() => boolean);
  // Workspace roots beyond cwd (the session's registered git worktrees).
  // Defaults to cwd alone.
  rootsProvider?: RootsProvider;
}

// Above this size, skip reading the file into memory just to show a diff —
// the diff output is already char-capped (MAX_DIFF_CHARS), so buffering a
// large file for it is pure waste.
const MAX_DELETE_PREVIEW_BYTES = 256 * 1024;

export function deleteFilePlugin(
  cwd: string,
  options: DeleteFilePluginOptions = {},
): ToolPlugin {
  const tool: ExtraTool = {
    definition: DELETE_FILE_DEFINITION,
    handler: async (call: ToolCall): Promise<ToolResult> => {
      const args = DeleteFileArgs(call.arguments);
      if (args instanceof type.errors) {
        return denyResult(call.id, "Failed to delete file: delete_file requires a non-empty path");
      }

      const allowOutside = resolveAllowOutside(options.allowOutside);
      // Containment is keyed off the parent directory, not the full target:
      // lstat/unlink never follow the final component, so unlinking a link
      // itself cannot escape even when the link dangles or points outside.
      // Resolving the full target would refuse both (UNRESOLVABLE / outside
      // referent). The shared workspace resolver still realpaths the session
      // root before comparing and admits registered sibling worktree roots —
      // the same boundary pathEscapePlugin enforces.
      const target = resolve(cwd, args.path);
      if (
        !allowOutside &&
        resolveWorkspacePath(
          cwd,
          dirname(target),
          options.rootsProvider ?? (() => []),
        ) === undefined
      ) {
        return denyResult(
          call.id,
          `Failed to delete file: ${args.path} resolves outside the working directory`,
        );
      }
      try {
        const info = await lstat(target);
        if (info.isDirectory()) {
          return denyResult(
            call.id,
            `Failed to delete file: ${args.path} is a directory; delete_file only deletes files`,
          );
        }
        // Best-effort content capture before removal, so the result can show
        // what was deleted (bounded, same as edit/write diffs). A failed read
        // (binary, permissions) never blocks the delete. Large files skip the
        // read entirely (see MAX_DELETE_PREVIEW_BYTES) and get a byte-count
        // summary instead.
        const tooLargeToPreview = info.size > MAX_DELETE_PREVIEW_BYTES;
        let before: string | undefined;
        if (!tooLargeToPreview) {
          try {
            before = await readFile(target, "utf8");
          } catch {
            // Unreadable or binary; delete proceeds without a diff.
          }
        }

        await unlink(target);
        let content = `Deleted file: ${args.path}`;
        if (tooLargeToPreview) {
          content += ` (${info.size.toLocaleString()} bytes; too large to preview, content omitted)`;
        } else if (before !== undefined) {
          const diff = formatChangeDiff(args.path, before, "");
          if (diff !== undefined) content += `\n\n${diff}`;
        }
        return { callId: call.id, content };
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          return {
            callId: call.id,
            content: `File already absent: ${args.path} (no action needed)`,
          };
        }
        return denyResult(call.id, `Failed to delete file: ${failureDetail(error)}`);
      }
    },
  };

  return { tools: [tool] };
}

function failureDetail(error: unknown): string {
  if (error instanceof Error) {
    const code =
      hasCode(error) && typeof error.code === "string"
        ? error.code
        : undefined;
    return code === undefined ? error.message : `${code}: ${error.message}`;
  }
  return String(error);
}

function errorCode(error: unknown): string | undefined {
  return hasCode(error) && typeof error.code === "string"
    ? error.code
    : undefined;
}
