import { lstat, readFile, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { type } from "arktype";
import type { ExtraTool, ToolPlugin } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { formatChangeDiff } from "./change-diff.js";

const DeleteFileArgs = type({ path: "string>0" });

const DELETE_FILE_DEFINITION = {
  name: "delete_file",
  description:
    "Delete one file. Returns success when the file is deleted or already absent. Refuses directories; use this instead of shell rm for file deletion.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to delete, relative to the working directory or absolute",
      },
    },
    required: ["path"],
  },
};

function errorResult(callId: string, message: string): ToolResult {
  return { callId, content: `Failed to delete file: ${message}`, isError: true };
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function failureDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = errorCode(error);
  return code === undefined ? error.message : `${code}: ${error.message}`;
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export interface DeleteFilePluginOptions {
  // When true (yolo / --dangerously-skip-permissions), delete outside the
  // working directory. A getter is resolved per call so `/yolo` mid-session
  // takes effect without rebuilding the plugin stack.
  allowOutside?: boolean | (() => boolean);
}

function resolveAllowOutside(value: boolean | (() => boolean) | undefined): boolean {
  if (typeof value === "function") return value();
  return value === true;
}

// Above this size, skip reading the file into memory just to show a diff —
// the diff output is already char-capped (MAX_DIFF_CHARS), so buffering a
// large file for it is pure waste, and deleting a large file is a common
// enough case that the read must not become a resource regression.
const MAX_DELETE_PREVIEW_BYTES = 256 * 1024;

export function deleteFilePlugin(cwd: string, options: DeleteFilePluginOptions = {}): ToolPlugin {
  const tool: ExtraTool = {
    definition: DELETE_FILE_DEFINITION,
    handler: async (call: ToolCall): Promise<ToolResult> => {
      const args = DeleteFileArgs(call.arguments);
      if (args instanceof type.errors) {
        return errorResult(call.id, "delete_file requires a non-empty path");
      }

      const allowOutside = resolveAllowOutside(options.allowOutside);
      const target = resolve(cwd, args.path);
      try {
        const [physicalRoot, physicalParent] = await Promise.all([
          realpath(cwd),
          realpath(dirname(target)),
        ]);
        if (!allowOutside && !isWithin(physicalRoot, physicalParent)) {
          return errorResult(call.id, `${args.path} resolves outside the working directory`);
        }
        const info = await lstat(target);
        if (info.isDirectory()) {
          return errorResult(
            call.id,
            `${args.path} is a directory; delete_file only deletes files`,
          );
        }
        // Best-effort content capture before removal, so the result can show
        // what was deleted (bounded, same as edit/write diffs). A failed read
        // (binary, permissions) never blocks the delete itself. Large files
        // skip the read entirely (see MAX_DELETE_PREVIEW_BYTES) and get a
        // byte-count summary instead.
        let before: string | undefined;
        const tooLargeToPreview = info.size > MAX_DELETE_PREVIEW_BYTES;
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
        return errorResult(call.id, failureDetail(error));
      }
    },
  };

  return { tools: [tool] };
}
