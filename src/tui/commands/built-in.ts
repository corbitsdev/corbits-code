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
  name: "auto",
  description: "Toggle auto-approve for file writes/edits and safe shell (recoverable via git)",
  handler: (_args, ctx) => {
    const enabled = ctx.toggleAuto();
    return {
      type: "message",
      text: enabled
        ? "Auto mode on — file writes/edits (recoverable via git) and safe shell run without asking."
        : "Auto mode off — every file write/edit and command will ask first.",
    };
  },
});

registerCommand({
  name: "diff",
  description: "Show the working-tree diff in the context panel",
  handler: (_args, _ctx) => ({ type: "view", view: "diff" }),
});

registerCommand({
  name: "agent",
  description: "Open the agent configuration surface (provider, model)",
  handler: (_args, _ctx) => ({ type: "modal", modal: "agent" }),
});

registerCommand({
  name: "permissions",
  description: "View and revoke remembered approvals across scopes",
  handler: (_args, _ctx) => ({ type: "overlay", overlay: "permissions" }),
});

// signalClear rotates to a fresh session: the on-screen transcript and run
// telemetry are reset and the agent is rebuilt against a new state directory,
// so the conversation starts empty. The prior session stays on disk under its
// own id. Nothing is sent to the model — this is a local reset, not a message.
registerCommand({
  name: "clear",
  description: "Start a fresh session in a new state directory",
  handler: (_args, ctx) => {
    ctx.signalClear();
    return { type: "message", text: "Started a fresh session." };
  },
});

registerCommand({
  name: "new",
  description: "Alias for /clear",
  handler: (_args, ctx) => {
    ctx.signalClear();
    return { type: "message", text: "Started a fresh session." };
  },
});

registerCommand({
  name: "mcp",
  description: "List connected MCP servers and their available tools",
  handler: (_args, ctx) => {
    const servers = ctx.getMCPServers?.() ?? [];
    if (servers.length === 0) {
      return { type: "message", text: "No MCP servers connected. Add mcpServers to .intercode/settings.json." };
    }
    const lines = servers.map((s) => {
      const toolList = s.tools.length > 0 ? s.tools.join(", ") : "(no tools)";
      return `${s.name}: ${toolList}`;
    });
    return { type: "message", text: lines.join("\n") };
  },
});
