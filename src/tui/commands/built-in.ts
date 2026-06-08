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
  name: "agent",
  description: "Open the agent configuration surface (provider, model)",
  handler: (_args, _ctx) => ({ type: "modal", modal: "agent" }),
});

// signalClear is a hook for future use — for example, persisting a pre-computed
// summary to the director before the boundary message is sent. It is currently
// a no-op because the director generates the context envelope from internal
// state when it processes the /clear message.
registerCommand({
  name: "clear",
  description: "Compact context and start a new task",
  handler: (_args, ctx) => {
    ctx.signalClear();
    return { type: "send", text: "/clear" };
  },
});

registerCommand({
  name: "new",
  description: "Alias for /clear",
  handler: (_args, ctx) => {
    ctx.signalClear();
    return { type: "send", text: "/new" };
  },
});

// /model is retained as an alias so existing muscle memory still lands somewhere
// sensible: it opens the same /agent surface where provider and model now live.
registerCommand({
  name: "model",
  description: "Alias for /agent (provider and model configuration)",
  handler: (_args, _ctx) => ({ type: "modal", modal: "agent" }),
});

registerCommand({
  name: "mcp",
  description: "List connected MCP servers and their available tools",
  handler: (_args, ctx) => {
    const servers = ctx.getMCPServers?.() ?? [];
    if (servers.length === 0) {
      return { type: "message", text: "No MCP servers connected. Add mcpServers to .interchange/settings.json." };
    }
    const lines = servers.map((s) => {
      const toolList = s.tools.length > 0 ? s.tools.join(", ") : "(no tools)";
      return `${s.name}: ${toolList}`;
    });
    return { type: "message", text: lines.join("\n") };
  },
});
