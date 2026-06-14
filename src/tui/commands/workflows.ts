import { registerCommand } from "./registry.js";
import { WORKFLOWS } from "../../workflows/index.js";

// Register a /<workflow-name> command for every built-in workflow. The handler
// asks the controller (wired through the command context) to start it. Names are
// validated to be slash-command-safe at registry load time.
for (const workflow of WORKFLOWS) {
  registerCommand({
    name: workflow.name,
    description: workflow.description,
    handler: (_args, ctx) => {
      if (ctx.startWorkflow === undefined) {
        return { type: "message", text: "Workflows are unavailable in this session." };
      }
      const msg = ctx.startWorkflow(workflow.name);
      // If start() returned a confirmation prompt (e.g. "already active") surface
      // it as a message without kicking the agent. Otherwise send a kickoff turn.
      if (!msg.startsWith("Started")) {
        return { type: "message", text: msg };
      }
      return { type: "send", text: `Begin the ${workflow.name} workflow.` };
    },
  });
}

registerCommand({
  name: "workflows",
  description: "Pick and start a coding workflow",
  handler: (_args, ctx) => {
    ctx.openWorkflowPicker?.();
    return { type: "noop" };
  },
});
