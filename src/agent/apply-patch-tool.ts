import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";

import { resolveWorkspacePath } from "../permission/path-restriction.js";
import type { RootsProvider } from "../permission/worktree-roots.js";
import {
  createExtraDeniedPathMatcher,
  isSensitivePathResolved,
} from "../plugins/secret-guard-plugin.js";
import {
  applyUpdateHunks,
  CodexApplyPatchError,
  parseCodexApplyPatch,
  type PatchOp,
} from "./codex-apply-patch.js";

export const applyPatchDefinition: ToolDefinition = {
  name: "apply_patch",
  description:
    "Edit files with a patch envelope: *** Begin Patch, then *** Add File: / *** Update File: (optional *** Move to:) / *** Delete File: sections, then *** End Patch. Update hunks start with @@ and use ' ', '-', '+' line prefixes. Paths are workspace-relative.",
  inputSchema: {
    type: "object",
    properties: {
      input: { type: "string", description: "The full patch envelope" },
    },
    required: ["input"],
  },
};

const ApplyPatchArgs = type({ input: "string" });

type Planned =
  | { kind: "write"; path: string; content: string; label: string }
  | { kind: "remove"; path: string; label: string };

export interface ApplyPatchGuard {
  allowOutside: () => boolean;
  rootsProvider: RootsProvider;
  extraDeniedPaths?: readonly string[];
}

// apply_patch is mounted outside the posix plugin stack, so it re-enforces
// the secret-guard denylist and realpath workspace bound itself; a lexical
// check alone would let a symlink inside the workspace lead out of it.
function guardedPath(
  cwd: string,
  path: string,
  guard: ApplyPatchGuard,
  isExtraDenied: (value: string) => boolean,
): string {
  const abs = resolve(cwd, path);
  if (isSensitivePathResolved(abs) || isExtraDenied(abs)) {
    throw new CodexApplyPatchError(
      `Access to sensitive file blocked by policy: ${path}`,
    );
  }
  if (
    !guard.allowOutside() &&
    resolveWorkspacePath(cwd, abs, guard.rootsProvider) === undefined
  ) {
    throw new CodexApplyPatchError(`path escapes the workspace: ${path}`);
  }
  return abs;
}

async function plan(
  op: PatchOp,
  contained: (path: string) => string,
): Promise<Planned[]> {
  if (op.type === "add") {
    const path = contained(op.path);
    return [
      { kind: "write", path, content: op.content, label: `A ${op.path}` },
    ];
  }
  if (op.type === "delete") {
    return [
      { kind: "remove", path: contained(op.path), label: `D ${op.path}` },
    ];
  }
  const source = contained(op.path);
  let original: string;
  try {
    original = await readFile(source, "utf8");
  } catch {
    throw new CodexApplyPatchError(`cannot read ${op.path} to update it`);
  }
  const content = applyUpdateHunks(original, op.hunks);
  if (op.moveTo === undefined) {
    return [{ kind: "write", path: source, content, label: `M ${op.path}` }];
  }
  return [
    {
      kind: "write",
      path: contained(op.moveTo),
      content,
      label: `M ${op.moveTo}`,
    },
    { kind: "remove", path: source, label: "" },
  ];
}

/** Plan every op before touching disk so a bad hunk in the last file cannot
 * leave earlier files half-patched. */
export function createApplyPatchTool(
  cwd: string,
  guard: ApplyPatchGuard,
): AgentTool {
  const isExtraDenied = createExtraDeniedPathMatcher(
    guard.extraDeniedPaths ?? [],
  );
  const contained = (path: string): string =>
    guardedPath(cwd, path, guard, isExtraDenied);
  return stringTool({
    definition: applyPatchDefinition,
    handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
      const parsedArgs = ApplyPatchArgs(rawArgs);
      if (parsedArgs instanceof type.errors) {
        return "Error: apply_patch requires input (string).";
      }
      try {
        const patch = parseCodexApplyPatch(parsedArgs.input);
        const steps: Planned[] = [];
        for (const op of patch.ops) steps.push(...(await plan(op, contained)));
        for (const step of steps) {
          if (step.kind === "write") {
            await mkdir(dirname(step.path), { recursive: true });
            await writeFile(step.path, step.content);
          } else {
            await rm(step.path, { force: true });
          }
        }
        const labels = steps.map((s) => s.label).filter((l) => l !== "");
        return `Success. Updated the following files:\n${labels.join("\n")}`;
      } catch (err) {
        if (err instanceof CodexApplyPatchError) return `Error: ${err.message}`;
        throw err;
      }
    },
  });
}
