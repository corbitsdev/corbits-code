import { describe, test, expect } from "bun:test";
import { resolveAgentPluginProfiles } from "./agent-plugins.js";
import type { PluginModule } from "./loader.js";
import type { PluginConfig } from "../config/settings.js";

function agentModule(
  id: string,
  agents: unknown[],
  opts: { enabled?: boolean } = {},
): { mod: PluginModule; config: Record<string, PluginConfig> } {
  const mod: PluginModule = {
    manifest: { id, name: id, kind: "agent" },
    agentPlugin: { agents },
  };
  const config: Record<string, PluginConfig> = {};
  if (opts.enabled !== false) config[id] = { enabled: true };
  return { mod, config };
}

const validProfile = {
  id: "scout",
  description: "Repository exploration sub-agent",
  capabilities: { mode: "allow" as const, tools: ["read_file", "search_files", "grep"] },
  systemPromptRole: "You explore repositories.",
};

describe("resolveAgentPluginProfiles", () => {
  test("collects profiles from enabled agent-kind plugins", async () => {
    const { mod, config } = agentModule("p1", [validProfile]);
    const profiles = await resolveAgentPluginProfiles([mod], config);
    expect(profiles.length).toBe(1);
    expect(profiles[0]!.id).toBe("scout");
  });

  test("skips profiles from disabled plugins", async () => {
    const { mod, config } = agentModule("p1", [validProfile], { enabled: false });
    expect(await resolveAgentPluginProfiles([mod], config)).toEqual([]);
  });

  test("ignores non-agent-kind modules even with an agentPlugin export", async () => {
    const mod: PluginModule = {
      manifest: { id: "cmd", name: "cmd", kind: "command" },
      agentPlugin: { agents: [validProfile] },
    };
    expect(await resolveAgentPluginProfiles([mod], { cmd: { enabled: true } })).toEqual([]);
  });

  test("ignores agent-kind modules with no agentPlugin export", async () => {
    const mod: PluginModule = {
      manifest: { id: "empty", name: "empty", kind: "agent" },
    };
    expect(await resolveAgentPluginProfiles([mod], { empty: { enabled: true } })).toEqual([]);
  });

  test("skips malformed profiles, keeps valid ones", async () => {
    const { mod, config } = agentModule("p1", [
      validProfile,
      { id: "bad", orchestrator: "nonexistent" }, // invalid orchestrator type
      { description: "missing id" }, // missing required id
    ]);
    const profiles = await resolveAgentPluginProfiles([mod], config);
    expect(profiles.length).toBe(1);
    expect(profiles[0]!.id).toBe("scout");
  });

  test("collects from multiple plugins and flattens", async () => {
    const a = agentModule("p1", [validProfile]);
    const b = agentModule("p2", [
      { id: "reviewer", description: "Code reviewer", systemPromptRole: "You review code." },
    ]);
    const profiles = await resolveAgentPluginProfiles([a.mod, b.mod], { ...a.config, ...b.config });
    expect(profiles.map((p) => p.id).sort()).toEqual(["reviewer", "scout"]);
  });

  test("profiles from a non-array agents field are skipped", async () => {
    const mod: PluginModule = {
      manifest: { id: "bad", name: "bad", kind: "agent" },
      agentPlugin: { agents: "not-an-array" } as unknown as { agents: unknown[] },
    };
    expect(await resolveAgentPluginProfiles([mod], { bad: { enabled: true } })).toEqual([]);
  });

  test("stamps plugin:<id> source for ordinary plugins", async () => {
    const { mod, config } = agentModule("p1", [validProfile]);
    const profiles = await resolveAgentPluginProfiles([mod], config);
    expect(profiles[0]!.source).toBe("plugin:p1");
  });

  test("preserves mod.source when set (claude marketplace)", async () => {
    const { mod, config } = agentModule("p1", [validProfile]);
    mod.source = "claude";
    const profiles = await resolveAgentPluginProfiles([mod], config);
    expect(profiles[0]!.source).toBe("claude");
  });

  // Gating uses isPluginModuleEnabled (same as skills), not the bare
  // isPluginEnabled (settings-only) that tool plugins use for consent-gating.
  test("loads profiles from a repo plugin with defaultEnabled and no settings entry", async () => {
    const mod: PluginModule = {
      manifest: { id: "p1", name: "p1", kind: "agent", defaultEnabled: true },
      agentPlugin: { agents: [validProfile] },
      origin: "repo",
    };
    const profiles = await resolveAgentPluginProfiles([mod], {});
    expect(profiles.map((p) => p.id)).toEqual(["scout"]);
  });

  test("does not load profiles from a non-repo plugin with defaultEnabled and no settings entry", async () => {
    const mod: PluginModule = {
      manifest: { id: "p1", name: "p1", kind: "agent", defaultEnabled: true },
      agentPlugin: { agents: [validProfile] },
      origin: "user",
    };
    expect(await resolveAgentPluginProfiles([mod], {})).toEqual([]);
  });

  test("explicit enabled: false overrides repo defaultEnabled", async () => {
    const mod: PluginModule = {
      manifest: { id: "p1", name: "p1", kind: "agent", defaultEnabled: true },
      agentPlugin: { agents: [validProfile] },
      origin: "repo",
    };
    expect(await resolveAgentPluginProfiles([mod], { p1: { enabled: false } })).toEqual([]);
  });

  test("skips profiles whose id collides with a closed DIRECTOR_IDS entry", async () => {
    const warnings: string[] = [];
    const { mod, config } = agentModule("p1", [
      validProfile,
      {
        id: "explorer",
        description: "Collides with closed director",
        systemPromptRole: "Should be skipped.",
      },
      {
        id: "builder",
        description: "Also reserved",
        systemPromptRole: "Should be skipped.",
      },
    ]);
    const profiles = await resolveAgentPluginProfiles([mod], config, (msg) => warnings.push(msg));
    expect(profiles.map((p) => p.id)).toEqual(["scout"]);
    expect(warnings.some((w) => w.includes('agent "explorer"') && w.includes("reserved"))).toBe(
      true,
    );
    expect(warnings.some((w) => w.includes('agent "builder"') && w.includes("reserved"))).toBe(
      true,
    );
  });
});
