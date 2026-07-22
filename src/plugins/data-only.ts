import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parsePluginManifest, type PluginManifest } from "./manifest.js";
import type { CommandDefinition, CommandPlugin } from "../tui/commands/registry.js";
import { loadDataOnlyAgentPlugin } from "./data-only-agent.js";
import { loadDataOnlyCommands } from "./data-only-commands.js";
import { loadSkillCommands } from "./skill-commands.js";

// A data-only plugin needs no `index.ts`: its contents are markdown/data files.
// This orchestrator unifies the per-kind data loaders (agents, commands, tagged
// skills) into a single PluginModule-shaped result, so `loadPluginEntry` has one
// call to make and one place that decides the manifest kind.

export type DataOnlyPlugin = {
  manifest: PluginManifest;
  agentPlugin?: { agents: unknown[] };
  commandPlugin?: CommandPlugin;
};

async function readManifestJson(dir: string): Promise<PluginManifest | null> {
  try {
    const raw = await readFile(join(dir, "manifest.json"), "utf8");
    return parsePluginManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

// Claude Code marketplace plugins self-describe via `.claude-plugin/plugin.json`
// (or occasionally `.claude-plugin/manifest.json`) with
// `{ name, description?, version?, author? }` — no `id`/`kind`. We adapt it
// to the corbits manifest: `name` becomes `id`+`name`; `kind` is inferred from
// the plugin's contents (agents present -> "agent", else "command") since a
// native root `manifest.json`, when present, is always preferred and authoritative.
type ClaudePluginManifest = { id: string; name: string; description?: string };

async function readClaudePluginManifestFile(
  path: string,
): Promise<ClaudePluginManifest | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    // Prefer name; some layouts put the marketplace id in `id` instead.
    const nameRaw =
      typeof obj.name === "string" && obj.name.trim().length > 0
        ? obj.name.trim()
        : typeof obj.id === "string" && obj.id.trim().length > 0
          ? obj.id.trim()
          : null;
    if (nameRaw === null) return null;
    const out: ClaudePluginManifest = { id: nameRaw, name: nameRaw };
    if (typeof obj.description === "string") out.description = obj.description;
    return out;
  } catch {
    return null;
  }
}

async function readClaudePluginManifest(dir: string): Promise<ClaudePluginManifest | null> {
  // plugin.json is the Claude Code convention; manifest.json is an observed
  // marketplace variant that still carries name/description.
  return (
    (await readClaudePluginManifestFile(join(dir, ".claude-plugin", "plugin.json"))) ??
    (await readClaudePluginManifestFile(join(dir, ".claude-plugin", "manifest.json")))
  );
}

export async function loadDataOnlyPlugin(
  pluginDir: string,
  opts: { cwd?: string; onWarning?: (msg: string) => void } = {},
): Promise<DataOnlyPlugin | null> {
  const cwd = opts.cwd ?? process.cwd();
  const onWarning =
    opts.onWarning ?? ((msg: string) => process.stderr.write(`plugins: ${msg}\n`));

  const [nativeManifest, claudeManifest, agents, commands, skillCmds] = await Promise.all([
    readManifestJson(pluginDir),
    readClaudePluginManifest(pluginDir),
    loadDataOnlyAgentPlugin(pluginDir, { cwd, onWarning }),
    loadDataOnlyCommands(pluginDir, { onWarning }),
    loadSkillCommands(pluginDir, { onWarning }),
  ]);

  const hasCommands =
    (commands !== null && commands.commandPlugin.commands.length > 0) ||
    (skillCmds !== null && skillCmds.length > 0);

  if (agents === null && !hasCommands) return null;

  // Manifest priority: native manifest.json (authoritative, carries kind) >
  // .claude-plugin/plugin.json (id/name/description; kind inferred) > dirname.
  // agents present -> "agent" (profiles wire; tagged skill-commands wire too via
  // agents present -> "agent" (profiles wire; skill-commands wire too via
  // the agent-kind allowance in register.ts); commands-only (incl. skills-only,
  // since every skill becomes a command) -> "command".
  const fallbackId = claudeManifest?.id ?? basename(pluginDir);
  let manifest: PluginManifest;
  if (nativeManifest !== null) {
    manifest = nativeManifest;
  } else {
    manifest = {
      id: fallbackId,
      name: claudeManifest?.name ?? fallbackId,
      kind: agents !== null ? "agent" : "command",
    };
    if (claudeManifest?.description !== undefined) manifest.description = claudeManifest.description;
  }

  // Merge command sources: explicit commands/*.md plus one command per skill.
  const allCommands: CommandDefinition[] = [];
  if (commands !== null) allCommands.push(...commands.commandPlugin.commands);
  if (skillCmds !== null) allCommands.push(...skillCmds);

  const result: DataOnlyPlugin = { manifest };
  if (agents !== null && agents.agentPlugin !== undefined) {
    result.agentPlugin = agents.agentPlugin;
  }
  if (allCommands.length > 0) {
    result.commandPlugin = { commands: allCommands };
  }
  return result;
}
