import { registerCommand } from "./registry.js";

registerCommand({
  name: "help",
  description: "Show the keyboard shortcut and command overlay",
  handler: (_args, _ctx) => ({ type: "overlay", overlay: "help" }),
});

registerCommand({
  name: "model",
  description: "Open the model configuration surface (provider, model)",
  handler: (_args, _ctx) => ({ type: "modal", modal: "agent" }),
});

registerCommand({
  name: "settings",
  description: "Open settings: permissions, compaction, and other options",
  handler: (_args, _ctx) => ({ type: "overlay", overlay: "settings" }),
});

registerCommand({
  name: "permissions",
  description: "Alias for /settings — view and revoke remembered approvals",
  handler: (_args, _ctx) => ({ type: "overlay", overlay: "settings" }),
});

registerCommand({
  name: "plugins",
  description: "Add plugins, set credentials, verify, and pick the web provider",
  handler: (_args, _ctx) => ({ type: "overlay", overlay: "plugins" }),
});

registerCommand({
  name: "login",
  description: "Sign in with Codex or xAI OAuth and manage profiles",
  subcommands: [
    { name: "codex", description: "Sign in with a ChatGPT Plus/Pro subscription" },
    { name: "xai", description: "Sign in with a SuperGrok or X Premium+ subscription" },
    { name: "grok", description: "Alias for xai" },
  ],
  handler: (args, _ctx) => {
    // With no argument, the bare command opens a provider picker so the user
    // can choose Codex or xAI before naming the profile. An explicit argument
    // skips the picker and goes straight to that provider's login modal.
    const provider = args.trim().toLowerCase();
    if (provider === "") return { type: "modal", modal: "login" };
    if (provider === "xai" || provider === "grok") return { type: "modal", modal: "xai-login" };
    return { type: "modal", modal: "codex-login" };
  },
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
