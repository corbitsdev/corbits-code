import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProfile } from "../agent/profiles.js";
import { AgentProfileSchema } from "../agent/profiles.js";
import { isDirectorId } from "../agent/directors/registry.js";
import type { PluginModule } from "./loader.js";
import type { PluginConfig } from "../config/settings.js";
import { isPluginModuleEnabled } from "./register.js";
import { pluginWarningSink, type PluginLoadDiagnostics } from "./diagnostics.js";
import { type } from "arktype";

export interface ResolveAgentPluginProfilesOptions {
  onWarning?: (msg: string) => void;
  diagnostics?: PluginLoadDiagnostics;
}

/**
 * Resolve the warning sink for profile validation. Prefer diagnostics when
 * provided; else an explicit onWarning; else silent drop (profiles are still
 * skipped either way — matching historical default).
 */
function resolveAgentProfileWarningHandler(
  opts: ResolveAgentPluginProfilesOptions | ((msg: string) => void),
): (msg: string) => void {
  if (typeof opts === "function") return opts;
  if (opts.diagnostics !== undefined) return pluginWarningSink(opts.diagnostics);
  if (opts.onWarning !== undefined) return opts.onWarning;
  return () => {};
}

// Collect agent profiles from every enabled agent-kind plugin. Each profile is
// validated against the AgentProfileSchema so a malformed entry is skipped
// rather than crashing the sub-agent dispatcher. Enabled-only gating (no
// consent) is sufficient: an agent profile is configuration data (tier,
// capabilities, role prompt), not in-process code execution. Gating uses
// isPluginModuleEnabled (same as skills), so a first-party repo plugin with
// manifest.defaultEnabled loads its profiles without an explicit settings
// entry. This differs from tool plugins (isToolPluginActive), which require
// explicit enabled+consented in settings even for repo plugins, because a
// tool plugin runs in-process code rather than declaring configuration data.
//
// Closed DIRECTOR_IDS are reserved (CL-7015): a plugin profile whose id
// collides with a shipped director is skipped with a warning — plugins cannot
// override or alias the closed fleet.
//
// Warnings fire whenever a profile is rejected so JS-plugin authors get the
// same feedback loop data-only plugin authors already enjoy. Pass `diagnostics`
// (preferred) or `onWarning`; a bare callback is still accepted for tests.
export async function resolveAgentPluginProfiles(
  modules: PluginModule[],
  config: Record<string, PluginConfig>,
  opts: ResolveAgentPluginProfilesOptions | ((msg: string) => void) = {},
): Promise<AgentProfile[]> {
  const onWarning = resolveAgentProfileWarningHandler(opts);
  const out: AgentProfile[] = [];
  for (const mod of modules) {
    if (mod.manifest?.kind !== "agent") continue;
    if (mod.agentPlugin === undefined) continue;
    if (!isPluginModuleEnabled(mod, config)) continue;

    const rawAgents = mod.agentPlugin.agents;
    if (!Array.isArray(rawAgents)) continue;
    for (const raw of rawAgents) {
      const result = AgentProfileSchema(raw);
      if (result instanceof type.errors) {
        const id =
          typeof raw === "object" && raw !== null && "id" in raw
            ? String((raw as { id: unknown }).id)
            : "<no id>";
        onWarning(`plugin "${mod.manifest.id}" agent "${id}" skipped: ${result.summary}`);
        continue;
      }
      const profile = { ...(result as AgentProfile) };
      if (isDirectorId(profile.id)) {
        onWarning(
          `plugin "${mod.manifest.id}" agent "${profile.id}" skipped: id is reserved for a closed director`,
        );
        continue;
      }
      // Resolve systemPromptPath relative to the plugin directory. The file
      // content becomes systemPromptRole; an explicit systemPromptRole wins.
      if (
        profile.systemPromptPath !== undefined &&
        profile.systemPromptRole === undefined &&
        mod.dir !== undefined
      ) {
        try {
          const promptRaw = await readFile(join(mod.dir, profile.systemPromptPath), "utf8");
          profile.systemPromptRole = promptRaw.trim();
        } catch {
          // Missing prompt file is non-fatal — the profile loads without a role.
        }
      }
      // Provenance for search_agents: Claude marketplace installs stamp
      // mod.source = "claude"; other plugins use plugin:<id>. Explicit profile
      // source (if ever set by the author) is left alone.
      if (profile.source === undefined) {
        if (mod.source !== undefined) {
          profile.source = mod.source;
        } else if (mod.manifest?.id !== undefined) {
          profile.source = `plugin:${mod.manifest.id}`;
        }
      }
      out.push(profile);
    }
  }
  return out;
}
