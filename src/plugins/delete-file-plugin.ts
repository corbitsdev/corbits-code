import { lstat, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { type } from "arktype";
import type { ExtraTool, ToolPlugin } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

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

export function deleteFilePlugin(cwd: string): ToolPlugin {
  const tool: ExtraTool = {
    definition: DELETE_FILE_DEFINITION,
    handler: async (call: ToolCall): Promise<ToolResult> => {
      const args = DeleteFileArgs(call.arguments);
      if (args instanceof type.errors) {
        return errorResult(call.id, "delete_file requires a non-empty path");
      }

      const target = resolve(cwd, args.path);
      try {
        const [physicalRoot, physicalParent] = await Promise.all([realpath(cwd), realpath(dirname(target))]);
        if (!isWithin(physicalRoot, physicalParent)) {
          return errorResult(call.id, `${args.path} resolves outside the working directory`);
        }
        const info = await lstat(target);
        if (info.isDirectory()) {
          return errorResult(call.id, `${args.path} is a directory; delete_file only deletes files`);
        }
        await unlink(target);
        return { callId: call.id, content: `Deleted file: ${args.path}` };
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
