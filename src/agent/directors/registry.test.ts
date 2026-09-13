import { describe, expect, test } from "bun:test";

import { DIRECTOR_IDS } from "./types.js";
import {
  DIRECTOR_REGISTRY,
  INTENT_DEFAULT_DIRECTOR,
  directorProfiles,
  isDirectorId,
  listDirectors,
  packageToProfile,
  resolveDirector,
  tierForDirectorId,
} from "./registry.js";

describe("director registry", () => {
  test("closed set has exactly 17 directors", () => {
    expect(DIRECTOR_IDS).toHaveLength(17);
    expect(listDirectors()).toHaveLength(17);
    for (const id of DIRECTOR_IDS) {
      expect(DIRECTOR_REGISTRY[id].id).toBe(id);
    }
  });

  test("every package has a real system prompt (no placeholders)", () => {
    for (const id of DIRECTOR_IDS) {
      const pkg = DIRECTOR_REGISTRY[id];
      expect(pkg.systemPrompt.length).toBeGreaterThan(40);
      expect(pkg.systemPrompt.startsWith("Placeholder")).toBe(false);
      expect(pkg.systemPrompt.toLowerCase()).toContain("primary intent");
    }
  });

  test("resolve by agentId", () => {
    const r = resolveDirector({ agentId: "skywalker" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.package.id).toBe("skywalker");
  });

  test("unknown agent errors with guidance", () => {
    const r = resolveDirector({ agentId: "pontusbot" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Unknown director");
      expect(r.hint).toContain("implement");
    }
  });

  test("intent map defaults (no general)", () => {
    expect(resolveDirector({ intent: "implement" })).toMatchObject({
      ok: true,
      package: { id: "builder" },
    });
    expect(resolveDirector({ intent: "explore" })).toMatchObject({
      ok: true,
      package: { id: "explorer" },
    });
    expect(resolveDirector({ intent: "plan" })).toMatchObject({
      ok: true,
      package: { id: "counsel" },
    });
    expect(resolveDirector({ intent: "review" })).toMatchObject({
      ok: true,
      package: { id: "critic" },
    });
    const general = resolveDirector({ intent: "general" });
    expect(general.ok).toBe(false);
    if (!general.ok) expect(general.error).toContain("general");
  });

  test("explicit agentId wins over intent", () => {
    const r = resolveDirector({ agentId: "greybeard", intent: "implement" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.package.id).toBe("greybeard");
  });

  test("missing agent and intent errors", () => {
    const r = resolveDirector({});
    expect(r.ok).toBe(false);
  });

  test("isDirectorId", () => {
    expect(isDirectorId("critic")).toBe(true);
    expect(isDirectorId("critique")).toBe(false);
    expect(isDirectorId("build")).toBe(false);
    expect(isDirectorId("nope")).toBe(false);
  });

  test("intent defaults table is complete for non-general intents", () => {
    expect(Object.keys(INTENT_DEFAULT_DIRECTOR).sort()).toEqual(
      ["explore", "implement", "plan", "review"].sort(),
    );
  });

  test("packageToProfile maps envelope and spawn", () => {
    const explorer = packageToProfile(DIRECTOR_REGISTRY.explorer);
    expect(explorer.id).toBe("explorer");
    expect(explorer.systemPromptRole).toContain("agent id `explorer`");
    expect(explorer.systemPromptRole).toContain(
      DIRECTOR_REGISTRY.explorer.systemPrompt,
    );
    expect(explorer.description).toContain("agent id: explorer");
    expect(explorer.capabilities?.mode).toBe("allow");
    expect(explorer.capabilities?.tools).toContain("read_file");
    expect(explorer.capabilities?.tools).toContain("write_file");
    expect(explorer.capabilities?.tools).toContain("edit_file");
    expect(explorer.capabilities?.tools).toContain("delete_file");
    expect(explorer.orchestrator).toBe(false);

    const grey = packageToProfile(DIRECTOR_REGISTRY.greybeard);
    expect(grey.orchestrator).toBe(true);

    const shakespeare = packageToProfile(DIRECTOR_REGISTRY.shakespeare);
    expect(shakespeare.capabilities?.mode).toBe("allow");
    expect(shakespeare.capabilities?.tools).toContain("write_file");
  });

  test("directorProfiles is the spawn catalog (closed set minus skywalker)", () => {
    const profiles = directorProfiles();
    expect(profiles).toHaveLength(16);
    expect(new Set(profiles.map((p) => p.id)).size).toBe(16);
    expect(profiles.map((p) => p.id)).not.toContain("skywalker");
  });

  // Phase 5 acceptance (CL-5818 / CL-5843): spawn matrix, review envelopes, primary stance.
  test("greybeard spawn allowlist is intern/explorer/critic only", () => {
    const g = DIRECTOR_REGISTRY.greybeard;
    expect(g.spawn.maySpawn).toBe(true);
    expect(g.spawn.allowlist?.slice().sort()).toEqual([
      "critic",
      "explorer",
      "intern",
    ]);
    expect(packageToProfile(g).orchestrator).toBe(true);
  });

  test("migrator is a dry-run-scoped leaf with no fleet verbs (CL-7671)", () => {
    const m = DIRECTOR_REGISTRY.migrator;
    expect(m.id).toBe("migrator");
    expect(m.tier).toBe("leaf");
    expect(m.spawn.maySpawn).toBe(false);
    expect(m.modelRole).toBe("plan");
    expect(m.tools?.allow).toEqual(["read_file", "grep", "lsp", "run_shell"]);
    expect(packageToProfile(m).orchestrator).toBe(false);
    expect(m.systemPrompt).toMatch(/dry-run and scratch-copy execution ONLY/);
    expect(m.systemPrompt).toMatch(/Background shells are forbidden/);
    const r = resolveDirector({ agentId: "migrator" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.package.id).toBe("migrator");
  });

  test("closed directors mount product write tools", () => {
    for (const id of [
      "critic",
      "greybeard",
      "neckbeard",
      "draper",
      "emil",
      "explorer",
      "counsel",
      "testsmith",
      "tester",
      "gaasbot",
      "intern",
      "builder",
      "shakespeare",
      "bruckheimer",
      "rand",
      "skywalker",
    ] as const) {
      const allow = DIRECTOR_REGISTRY[id].tools?.allow ?? [];
      expect(allow).toContain("write_file");
      expect(allow).toContain("edit_file");
      expect(allow).toContain("delete_file");
    }
  });

  test("builder mounts product writes + apply_patch; intern mounts writes without apply_patch; other leaves do not spawn", () => {
    expect(DIRECTOR_REGISTRY.builder.tools?.allow).toEqual(
      expect.arrayContaining([
        "write_file",
        "edit_file",
        "delete_file",
        "apply_patch",
      ]),
    );
    const internAllow = DIRECTOR_REGISTRY.intern.tools?.allow ?? [];
    expect(internAllow).toContain("run_shell");
    expect(internAllow).toContain("write_file");
    expect(internAllow).toContain("edit_file");
    expect(internAllow).toContain("delete_file");
    expect(internAllow).not.toContain("apply_patch");
    for (const id of DIRECTOR_IDS) {
      if (id === "skywalker" || id === "greybeard") continue;
      expect(DIRECTOR_REGISTRY[id].spawn.maySpawn).toBe(false);
    }
  });

  test("skywalker primary stance: DIY tiny writes, spawn for substantial work", () => {
    const s = DIRECTOR_REGISTRY.skywalker;
    expect(s.systemPrompt).toContain("write_file/edit_file/delete_file");
    expect(s.systemPrompt).toContain("DIY tiny/single-file/one-route");
    expect(s.systemPrompt).toContain("You are Skywalker");
    expect(s.systemPrompt).toMatch(/No catch-all worker/i);
    expect(s.tools?.allow).not.toContain("task");
    expect(s.tools?.allow).toContain("spawn_agent");
    // CL-7678: wait_agents is exec-primary opt-in, off the Skywalker allow —
    // TUI primary collects through mailbox mail.
    expect(s.tools?.allow).not.toContain("wait_agents");
    expect(s.tools?.allow).toContain("write_file");
    expect(s.tools?.allow).toContain("edit_file");
    expect(s.tools?.allow).toContain("delete_file");
    expect(s.spawn.allowlist).toHaveLength(16);
  });

  // CL-6941: tier and spawn.maySpawn independently encode "may this package
  // spawn", hand-set across 17 files. This pins their agreement so drift
  // (adding maySpawn: true without bumping tier, or vice versa) fails a test
  // instead of surfacing as an unexplained FleetAuthorityError at dispatch.
  test("tier agrees with spawn.maySpawn for every director", () => {
    for (const id of DIRECTOR_IDS) {
      const pkg = DIRECTOR_REGISTRY[id];
      expect(pkg.tier !== "leaf").toBe(pkg.spawn.maySpawn);
      expect(tierForDirectorId(id)).toBe(pkg.tier);
    }
    expect(DIRECTOR_REGISTRY.skywalker.tier).toBe("orchestrator");
    expect(DIRECTOR_REGISTRY.greybeard.tier).toBe("nested-orchestrator");
  });

  test("every director profile declares matching agent id in system prompt", () => {
    for (const id of DIRECTOR_IDS) {
      const profile = packageToProfile(DIRECTOR_REGISTRY[id]);
      expect(profile.systemPromptRole).toContain(`agent id \`${id}\``);
      expect(profile.systemPromptRole).toContain(`spawn_agent(agent="${id}")`);
      expect(profile.description).toContain(`agent id: ${id}`);
    }
  });
});
