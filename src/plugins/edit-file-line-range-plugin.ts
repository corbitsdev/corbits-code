import { readFile } from "node:fs/promises";
import type { ToolPlugin } from "@intx/tools-posix";
import { hasCode } from "@intx/types";
import {
  editFileArgsUseBothModes,
  parseEditFileMode,
  parseLineRangeFields,
  runEditFileLineRange,
} from "./edit-file-line-range.js";

/**
 * Short-circuits stock tools-posix edit_file for line-range mode (shell-guard pattern).
 */
export function editFileLineRangePlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      if (call.name !== "edit_file") {
        return next(call, signal);
      }

      let parseOptions: { fileContent?: string } | undefined;
      if (editFileArgsUseBothModes(call.arguments)) {
        const path = String(call.arguments.path ?? "");
        const new_string = call.arguments.new_string;
        if (typeof new_string === "string") {
          const rangeCheck = parseLineRangeFields(path, new_string, call.arguments);
          if (rangeCheck.kind === "invalid") {
            const parsed = parseEditFileMode(call.arguments);
            if (parsed.kind !== "invalid") {
              return {
                callId: call.id,
                content: rangeCheck.message,
                isError: true,
              };
            }
            return { callId: call.id, content: parsed.message, isError: true };
          }
        }

        try {
          const buf = await readFile(path, { signal });
          if (buf.includes(0)) {
            return {
              callId: call.id,
              content: `refusing to edit binary file: ${path}`,
              isError: true,
            };
          }
          parseOptions = { fileContent: buf.toString("utf8") };
        } catch (err) {
          if (hasCode(err) && err.code === "ENOENT") {
            return { callId: call.id, content: `file not found: ${path}`, isError: true };
          }
          return {
            callId: call.id,
            content: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }
      }

      const parsed = parseEditFileMode(call.arguments, parseOptions);
      if (parsed.kind === "invalid") {
        return { callId: call.id, content: parsed.message, isError: true };
      }
      if (parsed.kind === "substring") {
        return next(call, signal);
      }

      try {
        const content = await runEditFileLineRange(
          parsed,
          signal,
          parseOptions?.fileContent !== undefined
            ? { fileContentUtf8: parseOptions.fileContent }
            : undefined,
        );
        return { callId: call.id, content };
      } catch (err) {
        return {
          callId: call.id,
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  };
}