import { registerCommand } from "./registry.js";
import { PROVIDER_TIERS, type ProviderTier, type TierConfig } from "../../config/settings.js";
import { formatGoalStatus, type GoalSetOpts } from "../../agent/goal.js";
import { formatCostCommandOutput } from "../../cost/cost-summary.js";
import {
  formatStartupChangelog,
  parseChangelog,
  resolveChangelogPath,
} from "../../changelog/index.js";

// Which tiers are currently assigned. Defaults to empty so /fast, /standard,
// /clever stay out of the slash menu until the user configures one; the runner
// syncs this whenever tier state changes. getCommand still resolves them
// regardless, so an in-flight reconfigure never strands a typed command.
const configuredTiers = new Set<ProviderTier>();

export function setConfiguredTiers(tiers: Partial<Record<ProviderTier, TierConfig>>): void {
  configuredTiers.clear();
  for (const tier of PROVIDER_TIERS) {
    if (tiers[tier] !== undefined) configuredTiers.add(tier);
  }
}

const GOAL_CLEAR_ALIASES = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

/**
 * Parse /goal args.
 * - bare → status
 * - pause | resume | clear(+aliases)
 * - optional leading turn budget as a bare integer: `/goal 25 all tests pass`
 * - optional `--tokens N` / `--replace` flags (anywhere before the condition)
 * - remaining text is the condition
 *
 * `--turns N` is still accepted as a quiet alias for the leading integer form.
 */
export function parseGoalArgs(raw: string): {
  sub?: "pause" | "resume" | "clear" | "status";
  condition?: string;
  opts?: GoalSetOpts;
  replace?: boolean;
} {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { sub: "status" };

  const first = trimmed.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (first === "pause") return { sub: "pause" };
  if (first === "resume") return { sub: "resume" };
  if (GOAL_CLEAR_ALIASES.has(first)) return { sub: "clear" };

  let rest = trimmed;
  const opts: GoalSetOpts = {};
  let replace = false;

  // Leading bare integer is the optional turn budget: /goal 25 <condition>
  const leadingTurns = rest.match(/^(\d+)\s+/);
  if (leadingTurns !== null) {
    opts.turnBudget = Number(leadingTurns[1]);
    rest = rest.slice(leadingTurns[0].length);
  }

  // Optional flags: --tokens N, --replace, and legacy --turns N — any order.
  for (;;) {
    const turnsOrTokens = rest.match(/^--(turns|tokens)\s+(\d+)\s*/i);
    if (turnsOrTokens !== null) {
      const value = Number(turnsOrTokens[2]);
      if (turnsOrTokens[1]!.toLowerCase() === "turns") opts.turnBudget = value;
      else opts.tokenBudget = value;
      rest = rest.slice(turnsOrTokens[0].length);
      continue;
    }
    const replaceFlag = rest.match(/^--replace\s*/i);
    if (replaceFlag !== null) {
      replace = true;
      rest = rest.slice(replaceFlag[0].length);
      continue;
    }
    break;
  }
  const condition = rest.trim();
  if (condition.length === 0) return { sub: "status" };
  const result: {
    sub?: "pause" | "resume" | "clear" | "status";
    condition?: string;
    opts?: GoalSetOpts;
    replace?: boolean;
  } = { condition };
  if (Object.keys(opts).length > 0) result.opts = opts;
  if (replace) result.replace = true;
  return result;
}

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
    description: "Add plugins, set credentials, verify, and pick the web provider",
    handler: (_args, _ctx) => ({ type: "overlay", overlay: "plugins" }),
  });

  registerCommand({
    name: "hooks",
    description: "List discovered lifecycle hooks and enable or disable them",
    handler: (_args, _ctx) => ({ type: "overlay", overlay: "hooks" }),
  });

  // Models-first connect: providers are connected from /model (Ctrl+A / c), not a
  // standalone /login picker. Keep codex/xai login modals reachable only via
  // Connect or re-auth on an expired profile.

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

  registerCommand({
    name: "mcp",
    description: "List connected MCP servers and their available tools",
    handler: (_args, ctx) => {
      const servers = ctx.getMCPServers?.() ?? [];
      if (servers.length === 0) {
        return { type: "message", text: "No MCP servers connected. Add mcpServers to .corbits/settings.json." };
      }
      const lines = servers.map((s) => {
        const toolList = s.tools.length > 0 ? s.tools.join(", ") : "(no tools)";
        return `${s.name}: ${toolList}`;
      });
      return { type: "message", text: lines.join("\n") };
    },
  });

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

  // Session-scoped goal: keep working until a verifiable condition is met.
  // See docs/plans/v0.3-goal-mode.md.
  registerCommand({
    name: "goal",
    description: "Set a session goal brief; agent expands into an acceptance checklist",
    // Claude-style free-form arg guidance. Leading turns are optional positional
    // (`/goal 25 ship the feature`); omit for unlimited turns (default).
    argumentHint: "[turns] <brief>",
    subcommands: [
      { name: "pause", description: "Stop auto-continue; keep the goal" },
      { name: "resume", description: "Re-arm auto-continue (extends finite turn budget if limited)" },
      { name: "clear", description: "Drop the goal" },
      { name: "status", description: "Show acceptance checklist and progress" },
    ],

    handler: (args, ctx) => {
      const api = ctx.goal;
      if (api === undefined) {
        return { type: "message", text: "Goal mode is not available in this session." };
      }
      const parsed = parseGoalArgs(args);
      if (parsed.sub === "status") {
        return { type: "message", text: formatGoalStatus(api.get()) };
      }
      if (parsed.sub === "pause") {
        const snap = api.pause();
        if (snap === null) return { type: "message", text: "No goal is set." };
        return { type: "message", text: `Goal paused.\n${formatGoalStatus(snap)}` };
      }
      if (parsed.sub === "resume") {
        const snap = api.resume();
        if (snap === null) {
          return { type: "message", text: "No paused or budget-limited goal to resume." };
        }
        api.kickoff?.(snap.brief || snap.condition, "resume");
        return { type: "message", text: `Goal resumed.\n${formatGoalStatus(snap)}` };
      }
      if (parsed.sub === "clear") {
        if (api.get() === null) return { type: "message", text: "No goal is set." };
        api.clear();
        return { type: "message", text: "Goal cleared." };
      }
      const condition = parsed.condition ?? "";
      if (condition.length === 0) {
        return {
          type: "message",
          text: "Usage: /goal [turns] <brief> | /goal pause | /goal resume | /goal clear | /goal status",
        };
      }
      const existing = api.get();
      if (
        existing !== null &&
        (existing.status === "active" || existing.status === "paused" || existing.status === "budget_limited") &&
        parsed.replace !== true
      ) {
        return {
          type: "message",
          text:
            `A goal is already ${existing.status}:\n${formatGoalStatus(existing)}\n\n` +
            `Clear it first (/goal clear) or replace with /goal --replace <brief>.`,
        };
      }
      api.set(condition, parsed.opts);
      api.kickoff?.(condition, "set");
      // One-shot banner only — brief lives in GoalView chrome (multi-line here
      // used to overflow chrome row accounting and collide with Work).
      return { type: "message", text: "Goal set." };
    },
  });

  // One slash command per provider tier so a configured tier is one keystroke to
  // switch to. The handler only emits the intent; the runner resolves the tier's
  // current provider+model against live state and applies it, so a tier reassigned
  // mid-session via /model takes effect immediately on the next /<tier> call.
  for (const tier of PROVIDER_TIERS) {
    registerCommand({
      name: tier,
      description: `Switch the active model to the ${tier} tier`,
      handler: () => ({ type: "tier", tier: tier as ProviderTier }),
      available: () => configuredTiers.has(tier),
    });
  }
}
