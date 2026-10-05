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
  test("closed set has exactly 11 directors", () => {
    expect(DIRECTOR_IDS).toHaveLength(11);
    expect(listDirectors()).toHaveLength(11);
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
    expect(profiles).toHaveLength(10);
    expect(profiles.map((p) => p.id)).not.toContain("dispatch");
  });

  test("coder is a leaf with no spawn", () => {
    const c = DIRECTOR_REGISTRY.coder;
    expect(c.spawn.maySpawn).toBe(false);
    expect(c.spawn.allowlist).toBeUndefined();
    expect(c.tier).toBe("leaf");
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
    expect(s.spawn.allowlist).toHaveLength(10);
  });

  test("tier agrees with spawn.maySpawn for every director", () => {
    for (const id of DIRECTOR_IDS) {
      const pkg = DIRECTOR_REGISTRY[id];
      expect(pkg.tier !== "leaf").toBe(pkg.spawn.maySpawn);
      expect(tierForDirectorId(id)).toBe(pkg.tier);
    }
    expect(DIRECTOR_REGISTRY.dispatch.tier).toBe("orchestrator");
  });

  test("prober is a measure-only leaf", () => {
    const r = resolveDirector({ agentId: "prober" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.package.id).toBe("prober");
      expect(r.package.tier).toBe("leaf");
      expect(r.package.spawn.maySpawn).toBe(false);
      expect(r.package.modelRole).toBe("test");
    }
    expect(isDirectorId("prober")).toBe(true);
    expect(tierForDirectorId("prober")).toBe("leaf");
  });

  test("qa-lead is a hands-on leaf, not prober, with no spawn", () => {
    const r = resolveDirector({ agentId: "qa-lead" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.package.id).toBe("qa-lead");
      expect(r.package.tier).toBe("leaf");
      expect(r.package.spawn.maySpawn).toBe(false);
      expect(r.package.modelRole).toBe("test");
      expect(r.package.tools?.allow).toContain("write_file");
      expect(r.package.description).toMatch(/QA Lead/);
      expect(r.package.systemPrompt).toMatch(/QA Lead/);
      expect(r.package.systemPrompt).toMatch(/hands-on/i);
      expect(r.package.systemPrompt).toMatch(/corbits exec/i);
      expect(r.package.systemPrompt).toMatch(/bun test \.\/e2e/);
      expect(r.package.systemPrompt).toMatch(/eval:capability/);
      expect(r.package.systemPrompt).toMatch(/occupancy/i);
      expect(r.package.systemPrompt).toMatch(/never author unit tests/i);
      expect(r.package.systemPrompt).toMatch(
        /never measure family\/model latency/i,
      );
      expect(r.package.systemPrompt).toMatch(/never fix product code/i);
      expect(r.package).not.toBe(DIRECTOR_REGISTRY.prober);
    }
    expect(isDirectorId("qa-lead")).toBe(true);
    expect(isDirectorId("tester")).toBe(false);
    expect(tierForDirectorId("qa-lead")).toBe("leaf");
    expect(DIRECTOR_REGISTRY.dispatch.spawn.allowlist).toContain("qa-lead");
    expect(DIRECTOR_REGISTRY.dispatch.spawn.allowlist).not.toContain("tester");
  });

  test("dispatch card has no parallelization cap; duplicate is the same live job", () => {
    const card = DIRECTOR_REGISTRY.dispatch.systemPrompt;
    expect(card).toContain("no parallelization cap");
    expect(card).toMatch(/same live job/i);
    expect(card).not.toMatch(/Do not duplicate a live worker/i);
  });

  test("dispatch outOfLane spawns explorers instead of walking the repo", () => {
    const lanes = DIRECTOR_REGISTRY.dispatch.outOfLane.join("\n");
    expect(lanes).not.toMatch(/diagnostic fleet/i);
    expect(lanes).not.toMatch(/single explorer worker/i);
    expect(lanes).toMatch(/spawn explorer/i);
  });

  test("dispatch card routes direct answers vs targeted explorer vs specialist", () => {
    const card = DIRECTOR_REGISTRY.dispatch.systemPrompt;
    // Known context: answer directly when existing context supports it.
    expect(card).toMatch(/answer directly/i);
    expect(card).toMatch(/existing context/i);
    // Genuinely investigative: bounded missing evidence goes explorer/question.
    expect(card).toMatch(/missing evidence/i);
    expect(card).toMatch(/spawn explorer/i);
    // Implementation stays with the owning specialist.
    expect(card).toMatch(/spawn coder/i);
    // Boundary examples: conflicting/stale context, explanation-plus-implementation.
    expect(card).toMatch(/conflicting or stale/i);
    expect(card).toMatch(/explanation plus implementation/i);
  });

  test("dispatch card forbids guessing unknown facts to avoid a spawn", () => {
    const card = DIRECTOR_REGISTRY.dispatch.systemPrompt;
    expect(card).toMatch(/never guess/i);
    expect(card).toMatch(/targeted investigation/i);
  });

  test("dispatch direct-answer clarification adds no new card section", () => {
    const card = DIRECTOR_REGISTRY.dispatch.systemPrompt;
    const headings = [...card.matchAll(/^# .+$/gm)].map((m) => m[0]);
    expect(headings).toEqual([
      "# Role",
      "# Route",
      "# Delegation boundary",
      "# Rules",
      "# Spawn",
      "# Style",
    ]);
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
