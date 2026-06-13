import { registerCommand } from "./registry.js";
import { WORKFLOWS } from "../../workflows/index.js";

// Register a /<workflow-name> command for every built-in workflow. The handler
// asks the controller (wired through the command context) to start it. Names are
// validated to be slash-command-safe at registry load time.
for (const workflow of WORKFLOWS) {
  registerCommand({
    name: workflow.name,
    description: `Start the ${workflow.name} workflow — ${workflow.description}`,
    handler: (_args, ctx) => ({
      type: "message",
      text: ctx.startWorkflow?.(workflow.name) ?? "Workflows are unavailable in this session.",
    }),
  });
}

registerCommand({
  name: "workflows",
  description: "List the available workflows",
  handler: (_args, ctx) => {
    const list = ctx.listWorkflows?.() ?? [];
    if (list.length === 0) {
      return { type: "message", text: "No workflows are registered." };
    }
    const lines = list.map((w) => `/${w.name} — ${w.description}`);
    return { type: "message", text: lines.join("\n") };
  },
});
