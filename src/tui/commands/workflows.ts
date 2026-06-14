import { registerCommand } from "./registry.js";

registerCommand({
  name: "workflows",
  description: "Pick and start a coding workflow",
  handler: (_args, ctx) => {
    ctx.openWorkflowPicker?.();
    return { type: "noop" };
  },
});
