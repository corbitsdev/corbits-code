import { registerCommand } from "./registry.js";
import { WORKFLOWS } from "../../workflows/index.js";

// Register a /<workflow-name> command for every built-in workflow. The handler
// asks the controller (wired through the command context) to start it. Names are
// validated to be slash-command-safe at registry load time.
for (const workflow of WORKFLOWS) {
  registerCommand({
    name: workflow.name,
    description: workflow.description,
    handler: (_args, ctx) => ({
      type: "message",
      text: ctx.startWorkflow?.(workflow.name) ?? "Workflows are unavailable in this session.",
    }),
  });
}

registerCommand({
  name: "workflows",
  description: "Open the workflow steps panel",
  handler: (_args, ctx) => {
    ctx.openWorkflowPanel?.();
    return { type: "noop" };
  },
});
