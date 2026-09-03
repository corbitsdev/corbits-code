import { registerCommand } from "./registry.js";
import { formatCostCommandOutput } from "../../cost/cost-summary.js";
import {
  formatStartupChangelog,
  parseChangelog,
  resolveChangelogPath,
} from "../../changelog/index.js";
import { FEEDBACK_PROMPT, isFeedbackConfigured } from "../../telemetry/feedback.js";

/**
 * Register every built-in slash command.
 *
 * Called explicitly by the session runner — registration must never be an
 * import side effect, or a dropped importer silently empties the registry.
 * Idempotent: the registry is keyed by command name.
 */
export function registerBuiltInCommands(): void {
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
    description: "Add or remove plugins, set credentials, verify, and pick the web provider",
    handler: (_args, _ctx) => ({ type: "overlay", overlay: "plugins" }),
  });

  registerCommand({
    name: "hooks",
    description: "List discovered lifecycle hooks and enable or disable them",
    handler: (_args, _ctx) => ({ type: "overlay", overlay: "hooks" }),
  });

  // Layout-proof add-provider path: `/` works on every keyboard. There is no
  // standalone /login; OAuth sign-in is still reached only through this flow.
  registerCommand({
    name: "connect",
    description: "Add a provider account",
    handler: () => ({ type: "overlay", overlay: "add-provider" }),
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
    name: "rename",
    description: "Name the current session (shown in resume list and header)",
    handler: (args, ctx) => {
      const name = args.trim();
      if (name.length === 0) {
        return { type: "message", text: "Usage: /rename <name>" };
      }
      if (ctx.renameSession === undefined) {
        return { type: "message", text: "Renaming is not available in this mode." };
      }
      const err = ctx.renameSession(name);
      if (err !== undefined) {
        return { type: "message", text: err };
      }
      return { type: "message", text: `Session renamed to "${name}".` };
    },
  });

  registerCommand({
    name: "paste-image",
    description: "Attach the current clipboard image to the next message",
    handler: (_args, _ctx) => ({ type: "paste-image" }),
  });

  for (const name of ["mcp", "mcps"]) {
    registerCommand({
      name,
      description: "Show MCP servers and authorize the ones that need it",
      handler: (_args, _ctx) => ({ type: "overlay", overlay: "mcp" }),
    });
  }

  registerCommand({
    name: "cost",
    description: "Show session cost, token totals, and context-window usage",
    handler: (_args, ctx) => {
      const summary = ctx.getCostSummary?.();
      if (summary === undefined) {
        return { type: "message", text: "Cost tracking is not available in this session." };
      }
      return { type: "message", text: formatCostCommandOutput(summary) };
    },
  });

  registerCommand({
    name: "status",
    description: "Show what the dispatched fleet is doing right now",
    handler: (_args, ctx) => {
      const status = ctx.getFleetStatus?.();
      if (status === undefined) {
        return { type: "message", text: "Fleet status is not available in this session." };
      }
      return { type: "message", text: status };
    },
  });

  registerCommand({
    name: "changelog",
    description: "Show recent release notes (or full history)",
    argumentHint: "[full]",
    subcommands: [{ name: "full", description: "Show the complete changelog" }],
    handler: (args) => {
      const path = resolveChangelogPath();
      if (path === undefined) {
        return {
          type: "message",
          text: "CHANGELOG.md not found next to the install or package root.",
        };
      }
      const entries = parseChangelog(path);
      if (entries.length === 0) {
        return { type: "message", text: "No versioned release notes found in CHANGELOG.md." };
      }
      const wantFull = args.trim().toLowerCase() === "full";
      if (wantFull) {
        return {
          type: "message",
          text: entries.map((e) => e.content).join("\n\n"),
        };
      }
      const formatted = formatStartupChangelog(entries, {
        maxEntries: 5,
        fullHint: "Run /changelog full for complete history.",
      });
      return { type: "message", text: formatted.markdown };
    },
  });

  // Intentional product feedback → PostHog survey (headless). Can ship when
  // ambient telemetry is off; env kill switches still block. Free text 2000 cap.
  // Hidden from the slash menu until survey env ids are set (still callable).
  registerCommand({
    name: "feedback",
    description: "Send product feedback (env kill switches still apply)",
    argumentHint: "[your feedback]",
    available: () => isFeedbackConfigured(),
    handler: (args, ctx) => {
      const text = args.trim();
      if (text.length === 0) {
        if (ctx.beginFeedbackCapture === undefined) {
          return { type: "message", text: "Feedback is not available in this mode." };
        }
        ctx.beginFeedbackCapture();
        return { type: "message", text: FEEDBACK_PROMPT };
      }
      if (ctx.submitFeedback === undefined) {
        return { type: "message", text: "Feedback is not available in this mode." };
      }
      return { type: "message", text: ctx.submitFeedback(text) };
    },
  });

  // Persist as user-global default, not session-only.
  registerCommand({
    name: "yolo",
    description: "Skip permission prompts (persists as the default)",
    argumentHint: "[on|off|toggle]",
    subcommands: [
      { name: "on", description: "Enable skip-permissions" },
      { name: "off", description: "Disable skip-permissions" },
      { name: "toggle", description: "Toggle skip-permissions" },
    ],
    handler: (args, ctx) => {
      if (ctx.getSkipPermissions === undefined || ctx.setSkipPermissions === undefined) {
        return { type: "message", text: "Yolo mode is not available in this mode." };
      }
      const arg = args.trim().toLowerCase();
      let next: boolean;
      if (arg === "on") {
        next = true;
      } else if (arg === "off") {
        next = false;
      } else if (arg.length === 0 || arg === "toggle") {
        next = !ctx.getSkipPermissions();
      } else {
        return { type: "message", text: "Usage: /yolo [on|off|toggle]" };
      }
      ctx.setSkipPermissions(next);
      if (next) {
        return {
          type: "message",
          text: "Yolo mode on — permission prompts skipped. Saved as the default.",
        };
      }
      return {
        type: "message",
        text: "Yolo mode off — permission prompts restored. Saved as the default.",
      };
    },
  });
}
