import { scribe } from "@intercode/default-workflows";
import type { CommandPlugin } from "../../../src/tui/commands/registry.js";

// Discovered and wired in only when enabled via /plugins (explicit-enable).
export const manifest = {
  id: "scribe",
  name: "Scribe",
  kind: "command" as const,
  description:
    "Documentation workflow: audit docs against the code, plan changes, interview for depth, " +
    "write with cross-document consistency, and review for accuracy.",
};

export const commandPlugin: CommandPlugin = {
  commands: [
    {
      name: "scribe",
      description: "Audit, plan, interview, write, and review documentation",
      handler: (args, ctx) => {
        if (ctx.startWorkflow === undefined) {
          return { type: "message", text: "Workflows are not available in this context." };
        }

        const msg = ctx.startWorkflow("scribe");
        const target = args.trim();
        const send = target.length > 0
          ? `Begin the scribe workflow for: ${target}`
          : `Begin the scribe workflow.`;

        if (msg.startsWith("Started")) {
          return { type: "send", text: send };
        }
        return { type: "message", text: msg };
      },
    },
  ],
};

// The workflow itself is registered by @intercode/default-workflows (its recipes
// are the only thing the runtime can resolve by name). Re-exported here so the
// command and the definition it drives stay co-located.
export { scribe };
