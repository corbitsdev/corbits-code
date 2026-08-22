/**
 * Codex-only tool proxies. Factory only — mounting into createAgentToolset /
 * runSubAgent is intentionally out of scope for this module.
 */

import { type } from "arktype";
import { stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

import {
  CodexApplyPatchError,
  applyUpdateHunks,
  parseCodexApplyPatch,
  type PatchOp,
} from "./codex-apply-patch.js";

export type CodexRunTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ content: string; isError?: boolean }>;

export type CreateCodexToolProxiesOpts = {
  isCodex: boolean;
  runTool: CodexRunTool;
  /**
   * When false, Delete File and Update+Move refuse without calling `delete_file`.
   * Defaults to true (implement / unconstrained). Docs leaves pass false because
   * DOCS_TOOLS includes apply_patch but not delete_file.
   */
  allowDelete?: boolean;
};

const ApplyPatchArgs = type({
  input: "string>0",
});

/** Mirrors APPLY_PATCH_JSON_TOOL_DESCRIPTION from openai/codex apply_patch_tool.rs. */
export const APPLY_PATCH_DESCRIPTION = `Use the \`apply_patch\` tool to edit files.
Your patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high-level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

May be immediately followed by *** Move to: <new path> if you want to rename the file.
Then one or more “hunks”, each introduced by @@ (optionally followed by a hunk header).
Within a hunk each line starts with:

For instructions on [context_before] and [context_after]:
- By default, show 3 lines of code immediately above and 3 lines immediately below each change. If a change is within 3 lines of a previous change, do NOT duplicate the first change’s [context_after] lines in the second change’s [context_before] lines.
- If 3 lines of context is insufficient to uniquely identify the snippet of code within the file, use the @@ operator to indicate the class or function to which the snippet belongs. For instance, we might have:
@@ class BaseClass
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]

- If a code block is repeated so many times in a class or function such that even a single \`@@\` statement and 3 lines of context cannot uniquely identify the snippet of code, you can use multiple \`@@\` statements to jump to the right context. For instance:

@@ class BaseClass
@@ \tdef method():
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]

The full grammar definition is below:
Patch := Begin { FileOp } End
Begin := "*** Begin Patch" NEWLINE
End := "*** End Patch" NEWLINE
FileOp := AddFile | DeleteFile | UpdateFile
AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
DeleteFile := "*** Delete File: " path NEWLINE
UpdateFile := "*** Update File: " path NEWLINE [ MoveTo ] { Hunk }
MoveTo := "*** Move to: " newPath NEWLINE
Hunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine := (" " | "-" | "+") text NEWLINE

A full patch can combine several operations:

*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

It is important to remember:

- You must include a header with your intended action (Add/Delete/Update)
- You must prefix new lines with \`+\` even when creating a new file
- File references can only be relative, NEVER ABSOLUTE.
`;

export const applyPatchDefinition: ToolDefinition = {
  name: "apply_patch",
  description: APPLY_PATCH_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "The entire contents of the apply_patch command",
      },
    },
    required: ["input"],
  },
};

/**
 * When `isCodex` is false, returns []. Otherwise returns a single `apply_patch`
 * stringTool that parses the Codex envelope and forwards each op through
 * `runTool` (write_file / delete_file / read_file).
 */
export function createCodexToolProxies(opts: CreateCodexToolProxiesOpts): AgentTool[] {
  if (!opts.isCodex) return [];
  const allowDelete = opts.allowDelete !== false;
  return [createApplyPatchProxy(opts.runTool, allowDelete)];
}

/**
 * Resolve whether apply_patch may forward Delete / Move-delete given a leaf
 * capability filter. Allow-mode lists that omit `delete_file` (docs) refuse;
 * unconstrained / exclude-without-delete keep delete enabled.
 */
export function allowDeleteFromCapabilities(
  capabilities: { mode: "allow" | "exclude"; tools: readonly string[] } | undefined,
): boolean {
  if (capabilities === undefined) return true;
  if (capabilities.mode === "allow") {
    return capabilities.tools.includes("delete_file");
  }
  return !capabilities.tools.includes("delete_file");
}

function createApplyPatchProxy(runTool: CodexRunTool, allowDelete: boolean): AgentTool {
  return stringTool({
    definition: applyPatchDefinition,
    handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
      const parsed = ApplyPatchArgs(rawArgs);
      if (parsed instanceof type.errors) {
        // stringTool surfaces thrown errors as ToolResult.isError via createToolRunner.
        throw new Error("Error: apply_patch requires a non-empty input (string).");
      }

      let patch;
      try {
        patch = parseCodexApplyPatch(parsed.input);
      } catch (err) {
        if (err instanceof CodexApplyPatchError) throw err;
        throw err;
      }

      const lines: string[] = [];
      for (const op of patch.ops) {
        const result = await applyOp(op, runTool, allowDelete);
        lines.push(result);
      }
      if (lines.length === 0) return "apply_patch: no file operations in envelope.";
      return lines.join("\n");
    },
  });
}

async function applyOp(
  op: PatchOp,
  runTool: CodexRunTool,
  allowDelete: boolean,
): Promise<string> {
  if (op.type === "add") {
    return requireOk(
      await runTool("write_file", { path: op.path, content: op.content }),
      `add ${op.path}`,
    );
  }

  if (op.type === "delete") {
    if (!allowDelete) {
      throw new Error(
        `apply_patch: Delete File is not allowed for this agent (delete_file capability missing): ${op.path}`,
      );
    }
    return requireOk(await runTool("delete_file", { path: op.path }), `delete ${op.path}`);
  }

  // update (+ optional move): read → applyUpdateHunks → write (to moveTo or path)
  // → delete old path when moving. Refuse Move before any I/O when delete is disallowed.
  if (op.moveTo !== undefined && !allowDelete) {
    throw new Error(
      `apply_patch: Update File with Move to is not allowed for this agent (delete_file capability missing): ${op.path} → ${op.moveTo}`,
    );
  }

  const read = await runTool("read_file", { path: op.path });
  const original = requireOk(read, `read ${op.path}`);

  let updated: string;
  try {
    updated = applyUpdateHunks(original, op.hunks);
  } catch (err) {
    if (err instanceof CodexApplyPatchError) throw err;
    throw err;
  }

  const writePath = op.moveTo ?? op.path;
  const writeMsg = requireOk(
    await runTool("write_file", { path: writePath, content: updated }),
    `write ${writePath}`,
  );

  if (op.moveTo !== undefined) {
    const deleteMsg = requireOk(
      await runTool("delete_file", { path: op.path }),
      `delete ${op.path} (after move to ${op.moveTo})`,
    );
    return `${writeMsg}\n${deleteMsg}`;
  }

  return writeMsg;
}

function requireOk(
  result: { content: string; isError?: boolean },
  label: string,
): string {
  if (result.isError === true) {
    throw new Error(`apply_patch failed (${label}): ${result.content}`);
  }
  return result.content;
}
