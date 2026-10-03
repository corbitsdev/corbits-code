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
  test("closed set has exactly 10 directors", () => {
    expect(DIRECTOR_IDS).toHaveLength(10);
    expect(listDirectors()).toHaveLength(10);
    for (const id of DIRECTOR_IDS) {
      expect(DIRECTOR_REGISTRY[id].id).toBe(id);
    }
  });

  test("every package has a real system prompt (no placeholders)", () => {
    for (const id of DIRECTOR_IDS) {
      const pkg = DIRECTOR_REGISTRY[id];
      expect(pkg.systemPrompt.length).toBeGreaterThan(40);
      expect(pkg.systemPrompt.startsWith("Placeholder")).toBe(false);
    }
  });

  test("resolve by agentId", () => {
    const r = resolveDirector({ agentId: "dispatch" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.package.id).toBe("dispatch");
  });

  test("unknown agent errors with guidance", () => {
    const r = resolveDirector({ agentId: "pontusbot" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.length).toBeGreaterThan(0);
      expect(r.hint?.length).toBeGreaterThan(0);
    }
  });

  test("intent map defaults (no general)", () => {
    expect(resolveDirector({ intent: "implement" })).toMatchObject({
      ok: true,
      package: { id: "coder" },
    });
    expect(resolveDirector({ intent: "explore" })).toMatchObject({
      ok: true,
      package: { id: "explorer" },
    });
    expect(resolveDirector({ intent: "plan" })).toMatchObject({
      ok: true,
      package: { id: "planner" },
    });
    expect(resolveDirector({ intent: "review" })).toMatchObject({
      ok: true,
      package: { id: "reviewer" },
    });
    const general = resolveDirector({ intent: "general" });
    expect(general.ok).toBe(false);
  });

  test("explicit agentId wins over intent", () => {
    const r = resolveDirector({ agentId: "coder", intent: "plan" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.package.id).toBe("coder");
  });

  test("missing agent and intent errors", () => {
    const r = resolveDirector({});
    expect(r.ok).toBe(false);
  });

  test("isDirectorId", () => {
    expect(isDirectorId("reviewer")).toBe(true);
    expect(isDirectorId("coder")).toBe(true);
    expect(isDirectorId("planner")).toBe(true);
    expect(isDirectorId("critic")).toBe(false);
    expect(isDirectorId("builder")).toBe(false);
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
    expect(explorer.capabilities?.tools).not.toContain("write_file");
    expect(explorer.capabilities?.tools).not.toContain("edit_file");
    expect(explorer.capabilities?.tools).not.toContain("delete_file");
    expect(explorer.orchestrator).toBe(false);

    const reviewer = packageToProfile(DIRECTOR_REGISTRY.reviewer);
    expect(reviewer.orchestrator).toBe(false);

    const shakespeare = packageToProfile(DIRECTOR_REGISTRY.shakespeare);
    expect(shakespeare.capabilities?.mode).toBe("allow");
    expect(shakespeare.capabilities?.tools).toContain("write_file");
  });

  test("directorProfiles is the spawn catalog (closed set minus dispatch)", () => {
    const profiles = directorProfiles();
    expect(profiles).toHaveLength(9);
    expect(profiles.map((p) => p.id)).not.toContain("dispatch");
  });

  test("coder is a worker with no spawn", () => {
    const c = DIRECTOR_REGISTRY.coder;
    expect(c.spawn.maySpawn).toBe(false);
    expect(c.spawn.allowlist).toBeUndefined();
    expect(c.tier).toBe("worker");
    expect(packageToProfile(c).orchestrator).toBe(false);
  });

  test("dispatch is the only maySpawn:true closed director", () => {
    const spawners = DIRECTOR_IDS.filter(
      (id) => DIRECTOR_REGISTRY[id].spawn.maySpawn,
    );
    expect(spawners).toEqual(["dispatch"]);
  });

  test("explorer is read-only; other closed directors mount product writes", () => {
    const explorerAllow = DIRECTOR_REGISTRY.explorer.tools?.allow ?? [];
    expect(explorerAllow).not.toContain("write_file");
    expect(explorerAllow).not.toContain("edit_file");
    expect(explorerAllow).not.toContain("delete_file");
    for (const id of DIRECTOR_IDS) {
      if (id === "explorer") continue;
      const allow = DIRECTOR_REGISTRY[id].tools?.allow ?? [];
      expect(allow).toContain("write_file");
      expect(allow).toContain("edit_file");
      expect(allow).toContain("delete_file");
    }
  });

  test("dispatch primary mounts DIY writes plus the spawn surface", () => {
    const s = DIRECTOR_REGISTRY.dispatch;
    expect(s.tools?.allow).not.toContain("task");
    expect(s.tools?.allow).toContain("spawn_agent");
    expect(s.tools?.allow).not.toContain("wait_agents");
    expect(s.tools?.allow).toContain("write_file");
    expect(s.tools?.allow).toContain("edit_file");
    expect(s.tools?.allow).toContain("delete_file");
    expect(s.spawn.allowlist).toHaveLength(9);
  });

  test("tier agrees with spawn.maySpawn for every director", () => {
    for (const id of DIRECTOR_IDS) {
      const pkg = DIRECTOR_REGISTRY[id];
      expect(pkg.tier === "orchestrator").toBe(pkg.spawn.maySpawn);
      expect(tierForDirectorId(id)).toBe(pkg.tier);
    }
    expect(DIRECTOR_REGISTRY.dispatch.tier).toBe("orchestrator");
  });

  test("prober is a measure-only worker", () => {
    const r = resolveDirector({ agentId: "prober" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.package.id).toBe("prober");
      expect(r.package.tier).toBe("worker");
      expect(r.package.spawn.maySpawn).toBe(false);
      expect(r.package.modelRole).toBe("test");
    }
    expect(isDirectorId("prober")).toBe(true);
    expect(tierForDirectorId("prober")).toBe("worker");
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
