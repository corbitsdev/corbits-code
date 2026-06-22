import { scope } from "./workflows/scope.js";
import { build } from "./workflows/build.js";
import { review } from "./workflows/review.js";
import type { CommandPlugin } from "../../../src/tui/commands/registry.js";
import type { WorkflowPlugin } from "../../../src/workflows/definition.js";

export const workflowPlugin: WorkflowPlugin = {
  workflows: [scope, build, review],
};

export const commandPlugin: CommandPlugin = {
  commands: [
    {
      name: "linear",
      description: "Linear workflows (scope, build, review)",
      handler: (args, ctx) => {
        const parts = args.trim().split(/\s+/);
        const sub = parts[0] ?? "";
        const subcmdArgs = parts.slice(1).join(" ");

        const found = workflowPlugin.workflows.find((w) => w.name === sub);
        if (found === undefined) {
          const names = workflowPlugin.workflows.map((w) => w.name).join(", ");
          return { type: "message", text: `Unknown linear subcommand "${sub}". Available: ${names}` };
        }

        if (ctx.startWorkflow === undefined) {
          return { type: "message", text: "Workflows are not available in this session." };
        }

        const msg = ctx.startWorkflow(found.name);
        if (msg.startsWith("Started")) {
          const send = subcmdArgs.length > 0
            ? `Begin the ${found.name} workflow for: ${subcmdArgs}`
            : `Begin the ${found.name} workflow.`;
          return { type: "send", text: send };
        }
        return { type: "message", text: msg };
      },
    },
  ],
};