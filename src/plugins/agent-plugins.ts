import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProfile } from "../agent/profiles.js";
import { AgentProfileSchema } from "../agent/profiles.js";
import type { PluginModule } from "./loader.js";
import type { PluginConfig } from "../config/settings.js";
import { isPluginEnabled } from "./register.js";
import { type } from "arktype";

// Collect agent profiles from every enabled agent-kind plugin. Each profile is
// validated against the AgentProfileSchema so a malformed entry is skipped
// rather than crashing the sub-agent dispatcher. Enabled-only gating (no
// consent) is sufficient: an agent profile is configuration data (tier,
// capabilities, role prompt), not in-process code execution.
export async function resolveAgentPluginProfiles(
  modules: PluginModule[],
  config: Record<string, PluginConfig>,
): Promise<AgentProfile[]> {
  const out: AgentProfile[] = [];
  for (const mod of modules) {
    if (mod.manifest?.kind !== "agent") continue;
    if (mod.agentPlugin === undefined) continue;
    if (!isPluginEnabled(config, mod.manifest.id)) continue;

    const rawAgents = mod.agentPlugin.agents;
    if (!Array.isArray(rawAgents)) continue;
    for (const raw of rawAgents) {
      const result = AgentProfileSchema(raw);
      if (result instanceof type.errors) continue;
      const profile = result as AgentProfile;
      // Resolve systemPromptPath relative to the plugin directory. The file
      // content becomes systemPromptRole; an explicit systemPromptRole wins.
      if (profile.systemPromptPath !== undefined && profile.systemPromptRole === undefined && mod.dir !== undefined) {
        try {
          const promptRaw = await readFile(join(mod.dir, profile.systemPromptPath), "utf8");
          profile.systemPromptRole = promptRaw.trim();
        } catch {
          // Missing prompt file is non-fatal — the profile loads without a role.
        }
      }
      out.push(profile);
    }
  }
  return out;
}
