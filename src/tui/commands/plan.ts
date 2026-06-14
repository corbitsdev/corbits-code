import { registerCommand } from "./registry.js";

registerCommand({
  name: "plan-mode",
  description: "Enter plan mode — explore read-only, then submit a plan for approval before editing",
  handler: (_args, ctx) => {
    if (ctx.enterPlanMode === undefined) {
      return { type: "message", text: "Plan mode is not available in this session." };
    }
    ctx.enterPlanMode();
    return {
      type: "message",
      text: "Plan mode active. write_file and edit_file are disabled until you submit a plan and it is approved.",
    };
  },
});
