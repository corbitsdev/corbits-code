import { type } from "arktype";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  createBackgroundShellRegistry,
  type BackgroundShellExit,
  type BackgroundShellRegistry,
} from "../shell/background-shell.js";
import type { SpillBlobWriter } from "../plugins/result-truncation-plugin.js";

const ShellCollectArgs = type({
  shell_id: "string>0",
  action: "'collect' | 'cancel'",
  "wait_ms?": "number",
});
type ShellCollectArgs = typeof ShellCollectArgs.infer;

export const shellCollectDefinition: ToolDefinition = {
  name: "shell_collect",
  description:
    "Collect or cancel a background run_shell (started with background: true). " +
    'action="collect" returns the result once finished (or status running); ' +
    'action="cancel" kills the process group. Completion also arrives as a ' +
    "system message on a later turn — collect is for polling or retrieving " +
    "output again after eviction risk.",
  inputSchema: {
    type: "object",
    properties: {
      shell_id: {
        type: "string",
        description: "shell_id from the background run_shell start.",
      },
      action: {
        type: "string",
        enum: ["collect", "cancel"],
        description:
          '"collect" retrieves status/output; "cancel" kills the process group.',
      },
      wait_ms: {
        type: "number",
        description:
          'For action="collect": milliseconds to wait for completion before returning "running" (default 0, non-blocking).',
      },
    },
    required: ["shell_id", "action"],
  },
};

export function createSpillingBackgroundShellExitNotifier(args: {
  getBlobWriter?: () => SpillBlobWriter | undefined;
  notify: (exit: BackgroundShellExit) => void;
}): (exit: BackgroundShellExit) => void {
  return (exit) => {
    void (async () => {
      // Truncated output spills to the session blob store so the completion
      // message can point at a readable tool-output:/// URI.
      let spillUri: string | undefined;
      if (exit.outputTruncated) {
        const writeBlob = args.getBlobWriter?.();
        if (writeBlob !== undefined) {
          const key = `bg-shell-${exit.id}`;
          await writeBlob(
            key,
            new TextEncoder().encode(exit.output),
            "text/plain",
          );
          spillUri = `tool-output:///${key}`;
        }
      }
      args.notify(spillUri !== undefined ? { ...exit, spillUri } : exit);
    })();
  };
}

export function createShellCollectTool(
  registry: BackgroundShellRegistry = createBackgroundShellRegistry(),
) {
  return {
    definition: shellCollectDefinition,
    handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
      const parsed = ShellCollectArgs(rawArgs);
      if (parsed instanceof type.errors) {
        return "Error: shell_collect requires shell_id (string) and action ('collect' | 'cancel').";
      }
      const { shell_id, action } = parsed;
      if (action === "cancel") {
        if (!registry.cancel(shell_id)) {
          return `No running background shell with id ${shell_id}; it may have already finished or been collected.`;
        }
        return JSON.stringify({ shell_id, status: "cancelling" });
      }
      const snapshot = await registry.collect(shell_id, parsed.wait_ms ?? 0);
      if (snapshot.state === "running") {
        return JSON.stringify({ shell_id, status: "running" });
      }
      if (snapshot.state === "not-found") {
        return (
          `No background shell with id ${shell_id}. It may have been evicted from the ` +
          "completed ring; if its output was truncated, the completion message carried " +
          "a tool-output:/// URI for the full output."
        );
      }
      const { exit } = snapshot;
      return JSON.stringify({
        shell_id,
        status: "completed",
        exit_code: exit.exitCode,
        timed_out: exit.timedOut,
        ...(exit.spillUri !== undefined ? { output_uri: exit.spillUri } : {}),
        output: exit.output,
      });
    },
  };
}
