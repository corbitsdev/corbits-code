import { implementFeature } from "./workflows/implement-feature.js";
import type { CommandPlugin } from "../../../../../src/tui/commands/registry.js";
import type { WorkflowPlugin } from "../../../../../src/workflows/definition.js";

export const workflowPlugin: WorkflowPlugin = {
  workflows: [implementFeature],
};

export const commandPlugin: CommandPlugin = {
  commands: [
    {
      name: "implement-feature",
      description: "Plan, implement, test, and multi-agent review for a feature",
      handler: (args, ctx) => {
        if (ctx.startWorkflow === undefined) {
          return { type: "message", text: "Workflows are not available in this session." };
        }

        const msg = ctx.startWorkflow("implement-feature");
        const target = args.trim();
        const send =
          target.length > 0
            ? `Begin the implement-feature workflow for: ${target}`
            : "Begin the implement-feature workflow.";

        if (msg.startsWith("Started")) {
          return { type: "send", text: send };
        }
        return { type: "message", text: msg };
      },
    },
  ],
};
