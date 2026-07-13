import { readFile } from "node:fs/promises";
import type { ToolPlugin } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { withFileMutationLock } from "./file-mutation-lock.js";
import { applyLineRangeEdit, parseEditFileMode } from "./edit-file-line-range.js";

function mutationPath(call: ToolCall): string | undefined {
  if (call.name !== "edit_file" && call.name !== "write_file") return undefined;
  const path = call.arguments.path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

export function verifyPlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      const lockedPath = mutationPath(call);
      const run = async (): Promise<ToolResult> => {
        let before: string | undefined;
        if (call.name === "edit_file") {
          const path = String(call.arguments.path ?? "");
          try {
            before = await readFile(path, "utf8");
          } catch {
            // File may not exist yet; edit will likely fail downstream
          }
        }

        const result = await next(call, signal);

        if (call.name === "write_file" && !result.isError) {
          const path = String(call.arguments.path ?? "");
          const expected = String(call.arguments.content ?? "");
          try {
            const actual = await readFile(path, "utf8");
            if (actual !== expected) {
              return {
                callId: call.id,
                content: `Write verification failed: content mismatch`,
                isError: true,
              };
            }
          } catch (err) {
            return {
              callId: call.id,
              content: `Write verification failed: could not re-read file: ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            };
          }
        }

        if (call.name === "edit_file" && !result.isError && before !== undefined) {
          const path = String(call.arguments.path ?? "");
          const mode = parseEditFileMode(call.arguments, { fileContent: before });
          try {
            const actual = await readFile(path, "utf8");
            let expected: string;
            if (mode.kind === "line_range") {
              expected = applyLineRangeEdit(
                before,
                mode.start_line,
                mode.end_line,
                mode.new_string,
              );
            } else if (mode.kind === "substring") {
              expected = applyEdit(before, mode.old_string, mode.new_string, mode.replace_all);
            } else {
              return result;
            }
            if (actual !== expected) {
              return {
                callId: call.id,
                content: `Edit verification failed: content mismatch after replacement`,
                isError: true,
              };
            }
          } catch (err) {
            return {
              callId: call.id,
              content: `Edit verification failed: could not re-read file: ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            };
          }
        }

        return result;
      };

      if (lockedPath === undefined) {
        return run();
      }
      return withFileMutationLock(lockedPath, run);
    },
  };
}

function applyEdit(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
): string {
  if (oldStr.length === 0) return content;
  if (replaceAll) {
    return content.split(oldStr).join(newStr);
  }
  const idx = content.indexOf(oldStr);
  if (idx === -1) return content;
  return content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
}