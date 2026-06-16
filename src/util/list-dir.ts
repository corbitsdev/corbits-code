import { type } from "arktype";
import { readdir, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

const ListDirArgs = type({ "path?": "string" });

export const listDirDefinition: ToolDefinition = {
  name: "list_dir",
  description:
    "List the entries of a directory in the workspace. Use this instead of shelling out to ls or find when you just need to see what a directory contains.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path relative to the workspace root. Defaults to the root.",
      },
    },
    required: [],
  },
};

const MAX_ENTRIES = 200;

export async function listDirectory(cwd: string, path: string): Promise<string> {
  const rel = path.length > 0 ? path : ".";
  const abs = resolve(cwd, rel);
  if (abs !== cwd && !abs.startsWith(cwd + sep)) {
    return `Error: ${rel} is outside the workspace.`;
  }

  // A symlink inside the workspace can resolve to a target outside it; the
  // string prefix check above only sees the lexical path. Resolve the real path
  // of both the target and the root before comparing so symlink escapes are
  // refused.
  let realAbs: string;
  let realCwd: string;
  try {
    realAbs = await realpath(abs);
    realCwd = await realpath(cwd);
  } catch (err) {
    return `Error: cannot list ${rel}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (realAbs !== realCwd && !realAbs.startsWith(realCwd + sep)) {
    return `Error: ${rel} is outside the workspace.`;
  }

  let entries;
  try {
    entries = await readdir(realAbs, { withFileTypes: true });
  } catch (err) {
    return `Error: cannot list ${rel}: ${err instanceof Error ? err.message : String(err)}`;
  }

  const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
  if (names.length === 0) return `(empty directory) ${rel}`;

  const shown = names.slice(0, MAX_ENTRIES);
  const remaining = names.length - shown.length;
  return shown.join("\n") + (remaining > 0 ? `\n… (${remaining} more entries)` : "");
}

export function createListDirTool(cwd: string): AgentTool {
  return stringTool({
    definition: listDirDefinition,
    handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
      const parsed = ListDirArgs(rawArgs);
      if (parsed instanceof type.errors) {
        return "Error: list_dir requires path (string) if provided.";
      }
      const path = parsed.path ?? "";
      return listDirectory(cwd, path);
    },
  });
}
