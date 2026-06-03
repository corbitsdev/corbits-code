import { registerCommand, listCommands } from "./registry.js";

registerCommand({
  name: "help",
  description: "List all available slash commands",
  handler: (_args, _ctx) => {
    const commands = listCommands();
    const lines = commands.map((c) => `  /${c.name} — ${c.description}`);
    return { type: "message", text: lines.join("\n") };
  },
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
