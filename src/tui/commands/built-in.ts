import { registerCommand } from "./registry.js";

registerCommand({
  name: "help",
  description: "Show the keyboard shortcut and command overlay",
  handler: (_args, _ctx) => ({ type: "overlay", overlay: "help" }),
});

registerCommand({
  name: "verbose",
  description: "Toggle full tool argument and result output",
  handler: (_args, ctx) => {
    const enabled = ctx.toggleVerbose();
    return { type: "message", text: `Verbose mode ${enabled ? "on" : "off"}` };
  },
});

registerCommand({
  name: "diff",
  description: "Show the working-tree diff in the context panel",
  handler: (_args, _ctx) => ({ type: "view", view: "diff" }),
});

registerCommand({
  name: "plan",
  description: "Show the plan in the context panel",
  handler: (_args, _ctx) => ({ type: "view", view: "plan" }),
});

registerCommand({
  name: "model",
  description: "Show or set the active model (e.g. /model gpt-4o)",
  handler: (args, ctx) => {
    const trimmed = args.trim();
    if (trimmed.length === 0) {
      return { type: "message", text: `Current model: ${ctx.getModel()}` };
    }
    ctx.setModel(trimmed);
    return { type: "message", text: `Model set to: ${trimmed}` };
  },
});
