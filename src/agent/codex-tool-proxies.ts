/**
 * Codex-only tool proxies: `apply_patch`, `shell`, `update_plan`. Factory
 * only — mounting into createAgentToolset / runSubAgent is intentionally out
 * of scope for this module.
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
import type { TaskStatus } from "./tasks.js";

export type CodexRunTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ content: string; isError?: boolean }>;

/**
 * Reads a file's raw content (no `cat -n` line-number prefixes) for the
 * Update File leg of apply_patch. `read_file` — both the guard plugin and
 * the underlying @intx/tools-posix implementation — always numbers its
 * output for model display, so it cannot supply the raw text
 * `applyUpdateHunks` needs to match a patch's context lines against (CL-6966).
 */
export type CodexReadRawFile = (path: string) => Promise<{ content: string; isError?: boolean }>;

/**
 * Dispatches update_plan's translated call onto the real manage_tasks
 * handler. `manage_tasks` is not a posix tool — it has no handler in the
 * posixTools registry `runTool` forwards to — so this is its own callback,
 * wired at each mount site (src/agent/tools.ts, src/subagent/run.ts) to the
 * exact same manage_tasks stringTool handler that site installs.
 */
export type CodexRunManageTasks = (
  args: Record<string, unknown>,
) => Promise<{ content: string; isError?: boolean }>;

export interface CreateCodexToolProxiesOpts {
  isCodex: boolean;
  runTool: CodexRunTool;
  /**
   * Reads raw file content for apply_patch's Update File leg (CL-6966). Kept
   * separate from `runTool` because there is no tool name that returns raw
   * content — `read_file` always numbers its output.
   */
  readRawFile: CodexReadRawFile;
  /** Dispatches update_plan's translated manage_tasks(action="create") call. */
  runManageTasks: CodexRunManageTasks;
  /**
   * When false, Delete File and Update+Move refuse without calling `delete_file`.
   * Defaults to true (implement / unconstrained). Pass false when the
   * director allowlist omits delete_file (docs leaves mount it today).
   */
  allowDelete?: boolean;
  /**
   * When false, `shell` refuses without calling `run_shell`. Defaults to true.
   * Docs leaves pass false because DOCS_TOOLS omits run_shell.
   */
  allowShell?: boolean;
}

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
 * When `isCodex` is false, returns []. Otherwise returns the `apply_patch`,
 * `shell`, and `update_plan` stringTools: `apply_patch` parses the Codex
 * envelope and forwards each op through `runTool` (write_file / delete_file /
 * read_file); `shell` forwards onto `run_shell`; `update_plan` forwards onto
 * `manage_tasks`.
 */
export function createCodexToolProxies(opts: CreateCodexToolProxiesOpts): AgentTool[] {
  if (!opts.isCodex) return [];
  const allowDelete = opts.allowDelete !== false;
  const allowShell = opts.allowShell !== false;
  return [
    createApplyPatchProxy(opts.runTool, opts.readRawFile, allowDelete),
    createShellProxy(opts.runTool, allowShell),
    createUpdatePlanProxy(opts.runManageTasks),
  ];
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

/**
 * Resolve whether `shell` may forward onto `run_shell` given a leaf
 * capability filter. Mirrors allowDeleteFromCapabilities against `run_shell`
 * instead of `delete_file` — docs leaves (DOCS_TOOLS omits run_shell) refuse.
 */
export function allowShellFromCapabilities(
  capabilities: { mode: "allow" | "exclude"; tools: readonly string[] } | undefined,
): boolean {
  if (capabilities === undefined) return true;
  if (capabilities.mode === "allow") {
    return capabilities.tools.includes("run_shell");
  }
  return !capabilities.tools.includes("run_shell");
}

function createApplyPatchProxy(
  runTool: CodexRunTool,
  readRawFile: CodexReadRawFile,
  allowDelete: boolean,
): AgentTool {
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
        const result = await applyOp(op, runTool, readRawFile, allowDelete);
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
  readRawFile: CodexReadRawFile,
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

  // read_file (both the guard plugin and the underlying tools-posix impl)
  // numbers its output for model display, so it cannot supply the raw text
  // applyUpdateHunks needs to match context lines against (CL-6966).
  // readRawFile reads the file directly instead.
  const read = await readRawFile(op.path);
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

function requireOk(result: { content: string; isError?: boolean }, label: string): string {
  if (result.isError === true) {
    throw new Error(`${label} failed: ${result.content}`);
  }
  return result.content;
}

// --- shell (Codex's native command-execution tool) ---
//
// The pinned Codex base instructions (bridgeMessage in
// codex-responses-adapter.ts) name this tool `shell`, not `exec_command` — that
// is the only native name this codebase's own reference material documents, so
// it is the name proxied here.

const ShellArgs = type({
  command: "string | string[]",
  "workdir?": "string",
  "timeout_ms?": "number",
});

export const shellDefinition: ToolDefinition = {
  name: "shell",
  description: "Runs a shell command and returns its output.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        description:
          'The command to run, as a shell string or an argv array (e.g. ["bash","-lc","ls"]).',
      },
      workdir: { type: "string", description: "Working directory for the command." },
      timeout_ms: { type: "number", description: "Timeout in milliseconds." },
    },
    required: ["command"],
  },
};

const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh"]);

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-./:=@%]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Codex's `shell` tool sends `command` as either a plain string or an argv
 * array. `run_shell` takes a single shell string. The common argv shape is a
 * `[shell, "-lc"|"-c", script]` triple — unwrap that to the script verbatim so
 * embedded spaces/quoting survive. Any other array is shell-quoted element by
 * element and joined, which is lossy for exotic argv (e.g. a NUL byte in an
 * arg) but matches ordinary command arrays.
 */
function normalizeShellCommand(command: string | string[]): string {
  if (typeof command === "string") return command;
  if (
    command.length === 3 &&
    SHELL_WRAPPERS.has(command[0]!.replace(/^.*\//, "")) &&
    (command[1] === "-lc" || command[1] === "-c")
  ) {
    return command[2]!;
  }
  return command.map(shellQuote).join(" ");
}

function createShellProxy(runTool: CodexRunTool, allowShell: boolean): AgentTool {
  return stringTool({
    definition: shellDefinition,
    handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
      const parsed = ShellArgs(rawArgs);
      if (parsed instanceof type.errors) {
        throw new Error("Error: shell requires a command (string or string[]).");
      }
      if (!allowShell) {
        throw new Error("shell: not allowed for this agent (run_shell capability missing).");
      }
      const args: Record<string, unknown> = { command: normalizeShellCommand(parsed.command) };
      if (parsed.workdir !== undefined) args.cwd = parsed.workdir;
      if (parsed.timeout_ms !== undefined) args.timeout = parsed.timeout_ms;
      return requireOk(await runTool("run_shell", args), "shell");
    },
  });
}

// --- update_plan (Codex's native plan/checklist tool) ---

const CodexPlanStatus = type("'pending' | 'in_progress' | 'completed'");

const UpdatePlanArgs = type({
  "explanation?": "string",
  plan: type({
    step: "string>0",
    status: CodexPlanStatus,
  }).array(),
});

export const updatePlanDefinition: ToolDefinition = {
  name: "update_plan",
  description:
    "Updates your task plan. Provide the full ordered list of plan steps, each with a status.",
  inputSchema: {
    type: "object",
    properties: {
      explanation: { type: "string" },
      plan: {
        type: "array",
        items: {
          type: "object",
          properties: {
            step: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
            },
          },
          required: ["step", "status"],
        },
      },
    },
    required: ["plan"],
  },
};

function codexPlanStatusToTaskStatus(status: typeof CodexPlanStatus.infer): TaskStatus {
  if (status === "pending") return "todo";
  if (status === "in_progress") return "doing";
  return "done";
}

function createUpdatePlanProxy(runManageTasks: CodexRunManageTasks): AgentTool {
  return stringTool({
    definition: updatePlanDefinition,
    handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
      const parsed = UpdatePlanArgs(rawArgs);
      if (parsed instanceof type.errors) {
        throw new Error("Error: update_plan requires a plan array of { step, status }.");
      }
      // manage_tasks has no "cancelled" equivalent in Codex's plan shape
      // (pending/in_progress/completed) — this proxy never produces it, so a
      // Codex model cannot cancel a step through update_plan. That is a
      // lossy-but-safe narrowing (dropped, not misrepresented), not a bug fix
      // for the underlying manage_tasks tool, which stays out of scope here.
      const tasks = parsed.plan.map((item, i) => ({
        id: `p${i + 1}`,
        title: item.step,
        status: codexPlanStatusToTaskStatus(item.status),
      }));
      return requireOk(await runManageTasks({ action: "create", tasks }), "update_plan");
    },
  });
}
