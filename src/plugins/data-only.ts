import { readFile, readdir, stat } from "node:fs/promises";
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
// with `{ name, description?, version?, author? }` — no `id`/`kind`. We adapt it
// to the intercode manifest: `name` becomes `id`+`name`; `kind` is inferred from
// the plugin's contents (agents present -> "agent", else "command") since a
// native `manifest.json`, when present, is always preferred and authoritative.
type ClaudePluginManifest = { id: string; name: string; description?: string };

async function readClaudePluginManifest(dir: string): Promise<ClaudePluginManifest | null> {
  try {
    const raw = await readFile(join(dir, ".claude-plugin", "plugin.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.name !== "string" || obj.name.trim().length === 0) return null;
    const id = obj.name.trim();
    const out: ClaudePluginManifest = { id, name: id };
    if (typeof obj.description === "string") out.description = obj.description;
    return out;
  } catch {
    return null;
  }
}

// A skills-only plugin (no agents, no commands) still has a reason to exist:
// enabling it adds its `skills/` to the use_skill search path. Detect a skills
// root with at least one SKILL.md so such plugins are loadable + enableable.
async function pluginHasSkills(dir: string): Promise<boolean> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(join(dir, "skills"), { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await stat(join(dir, "skills", entry.name, "SKILL.md"));
      return true;
    } catch {
      // not a skill folder, keep scanning
    }
  }
  return false;
}

export async function loadDataOnlyPlugin(
  pluginDir: string,
  opts: { cwd?: string; onWarning?: (msg: string) => void } = {},
): Promise<DataOnlyPlugin | null> {
  const cwd = opts.cwd ?? process.cwd();
  const onWarning =
    opts.onWarning ?? ((msg: string) => process.stderr.write(`plugins: ${msg}\n`));

  const [nativeManifest, claudeManifest, agents, commands, skillCmds, hasSkills] = await Promise.all([
    readManifestJson(pluginDir),
    readClaudePluginManifest(pluginDir),
    loadDataOnlyAgentPlugin(pluginDir, { cwd, onWarning }),
    loadDataOnlyCommands(pluginDir, { onWarning }),
    loadSkillCommands(pluginDir, { onWarning }),
    pluginHasSkills(pluginDir),
  ]);

  const hasCommands =
    (commands !== null && commands.commandPlugin.commands.length > 0) ||
    (skillCmds !== null && skillCmds.length > 0);

  // A skills-only plugin (no agents, no commands) is still valid: enabling it
  // exposes its skills via use_skill.
  if (agents === null && !hasCommands && !hasSkills) return null;

  // Manifest priority: native manifest.json (authoritative, carries kind) >
  // .claude-plugin/plugin.json (id/name/description; kind inferred) > dirname.
  // agents present -> "agent" (profiles wire; tagged skill-commands wire too via
  // the agent-kind allowance in register.ts); commands-only -> "command";
  // skills-only -> "agent" (the context/profile umbrella kind, so the plugin is
  // enableable and its skills resolve through use_skill).
  const fallbackId = claudeManifest?.id ?? basename(pluginDir);
  let manifest: PluginManifest;
  if (nativeManifest !== null) {
    manifest = nativeManifest;
  } else {
    manifest = {
      id: fallbackId,
      name: claudeManifest?.name ?? fallbackId,
      kind: agents !== null ? "agent" : hasCommands ? "command" : "agent",
    };
    if (claudeManifest?.description !== undefined) manifest.description = claudeManifest.description;
  }

  // Merge command sources: explicit commands/*.md plus tagged skill commands.
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
