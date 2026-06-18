import { scope, scribe, build, review } from "@intercode/default-workflows";
import type { CommandPlugin } from "../../../src/tui/commands/registry.js";

// Discovered and wired in only when enabled via /plugins (explicit-enable).
export const manifest = {
  id: "linear-workflows",
  name: "Linear Workflows",
  kind: "command" as const,
  description: "Linear-integrated coding workflows under /linear (scope, scribe, build, review).",
};

const SUBCOMMANDS = [
  { name: "scope", description: "Scope a feature or task — creates a Linear issue/project or a local scope file" },
  { name: "scribe", description: "Write or update documentation for the given target" },
  { name: "build", description: "Full implementation workflow: implement, document, and review" },
  { name: "review", description: "Multi-agent review cycle: greybeard, CTO, critic, and UI reviewers when applicable" },
] as const;

export const commandPlugin: CommandPlugin = {
  commands: [
    {
      name: "linear",
      description: "Linear-integrated coding workflows",
      subcommands: SUBCOMMANDS,
      handler: (args, ctx) => {
        const [sub, ...rest] = args.trim().split(/\s+/);
        const subcmdArgs = rest.join(" ");

        if (sub === undefined || sub === "") {
          const list = SUBCOMMANDS.map((s) => `/${s.name}  ${s.description}`).join("\n");
          return { type: "message", text: `Available subcommands:\n${list}` };
        }

        const found = SUBCOMMANDS.find((s) => s.name === sub);
        if (found === undefined) {
          return { type: "message", text: `Unknown subcommand "${sub}". Try /linear without arguments to see the list.` };
        }

        if (ctx.startWorkflow === undefined) {
          return { type: "message", text: "Workflows are not available in this context." };
        }

        const msg = ctx.startWorkflow(found.name);
        const send = subcmdArgs.length > 0
          ? `Begin the ${found.name} workflow for: ${subcmdArgs}`
          : `Begin the ${found.name} workflow.`;

        if (msg.startsWith("Started") || msg.startsWith("Auto-started")) {
          return { type: "send", text: send };
        }
        return { type: "message", text: msg };
      },
    },
  ],
};

// Re-export so the plugin loader can also see the workflow definitions if needed.
export { scope, scribe, build, review };
