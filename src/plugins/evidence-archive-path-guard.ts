import type { ToolPlugin } from "@intx/tools-posix";

import { looksLikePath } from "./path-escape-plugin.js";

const PATH_TOOLS = new Set([
  "read_file",
  "grep",
  "search_files",
  "list_dir",
  "write_file",
  "edit_file",
  "delete_file",
]);

const DENY_MESSAGE =
  "Cannot read evidence-archive or tool-output/archive-* with this tool. Use search_archive and read_archive with archive:/// refs.";

export function isProtectedEvidenceLocation(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  if (/(?:^|\/)evidence-archive(?:\/|$)/.test(normalized)) return true;
  if (/(?:^|\/)tool-output\/archive-/.test(normalized)) return true;
  if (/^tool-output:\/+archive-/.test(normalized)) return true;
  return false;
}

export function evidenceArchivePathGuardPlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      if (!PATH_TOOLS.has(call.name)) return next(call, signal);
      for (const [key, value] of Object.entries(call.arguments)) {
        if (typeof value === "string" && looksLikePath(key) && isProtectedEvidenceLocation(value)) {
          return { callId: call.id, content: DENY_MESSAGE, isError: true };
        }
      }
      return next(call, signal);
    },
  };
}
