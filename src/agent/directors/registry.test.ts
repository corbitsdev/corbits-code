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
} from "./registry.js";

describe("director registry", () => {
  test("closed set has exactly 16 directors", () => {
    expect(DIRECTOR_IDS).toHaveLength(16);
    expect(listDirectors()).toHaveLength(16);
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
      expect(pkg.report.requiredSections).toEqual(
        expect.arrayContaining(["Summary", "Findings", "Blockers", "Paths"]),
      );
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
      package: { id: "implement" },
    });
    expect(resolveDirector({ intent: "explore" })).toMatchObject({
      ok: true,
      package: { id: "explore" },
    });
    expect(resolveDirector({ intent: "plan" })).toMatchObject({
      ok: true,
      package: { id: "plan" },
    });
    expect(resolveDirector({ intent: "review" })).toMatchObject({
      ok: true,
      package: { id: "critique" },
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
    expect(isDirectorId("critique")).toBe(true);
    expect(isDirectorId("nope")).toBe(false);
  });

  test("intent defaults table is complete for non-general intents", () => {
    expect(Object.keys(INTENT_DEFAULT_DIRECTOR).sort()).toEqual(
      ["explore", "implement", "plan", "review"].sort(),
    );
  });

  test("packageToProfile maps envelope and spawn", () => {
    const explore = packageToProfile(DIRECTOR_REGISTRY.explore);
    expect(explore.id).toBe("explore");
    expect(explore.systemPromptRole).toBe(DIRECTOR_REGISTRY.explore.systemPrompt);
    expect(explore.capabilities?.mode).toBe("allow");
    expect(explore.capabilities?.tools).toContain("read_file");
    expect(explore.capabilities?.tools).not.toContain("write_file");
    expect(explore.orchestrator).toBe(false);

    const grey = packageToProfile(DIRECTOR_REGISTRY.greybeard);
    expect(grey.orchestrator).toBe(true);
    expect(grey.maxTurns).toBe(DIRECTOR_REGISTRY.greybeard.nudge?.maxTurns);

    const shakespeare = packageToProfile(DIRECTOR_REGISTRY.shakespeare);
    expect(shakespeare.writePaths).toEqual([
      "PRODUCT.md",
      "ARCHITECTURE.md",
      "IMPLEMENTATION.md",
    ]);
    expect(shakespeare.capabilities?.mode).toBe("allow");
    expect(shakespeare.capabilities?.tools).toContain("write_file");
  });

  test("directorProfiles covers closed set", () => {
    const profiles = directorProfiles();
    expect(profiles).toHaveLength(16);
    expect(new Set(profiles.map((p) => p.id)).size).toBe(16);
  });

  // Phase 5 acceptance (CL-5818 / CL-5843): spawn matrix, review envelopes, primary stance.
  test("greybeard spawn allowlist is intern/explore/critique only", () => {
    const g = DIRECTOR_REGISTRY.greybeard;
    expect(g.spawn.maySpawn).toBe(true);
    expect(g.spawn.allowlist?.slice().sort()).toEqual(["critique", "explore", "intern"]);
    expect(packageToProfile(g).orchestrator).toBe(true);
  });

  test("review and design leaves deny product write tools", () => {
    for (const id of [
      "critique",
      "greybeard",
      "neckbeard",
      "draper",
      "emil",
      "explore",
      "plan",
      "testsmith",
      "tester",
      "gaasbot",
      "skywalker",
    ] as const) {
      const allow = DIRECTOR_REGISTRY[id].tools?.allow ?? [];
      expect(allow).not.toContain("write_file");
      expect(allow).not.toContain("edit_file");
      expect(allow).not.toContain("delete_file");
    }
  });

  test("docs writePaths: shakespeare trio + brand DESIGN.md + bruckheimer PRODUCT", () => {
    expect(DIRECTOR_REGISTRY.shakespeare.writePaths).toEqual([
      "PRODUCT.md",
      "ARCHITECTURE.md",
      "IMPLEMENTATION.md",
    ]);
    expect(DIRECTOR_REGISTRY["brand-reviewer"].writePaths).toEqual(["DESIGN.md"]);
    expect(DIRECTOR_REGISTRY.bruckheimer.writePaths).toEqual(["PRODUCT.md", "docs/*"]);
  });

  test("implement mounts product writes; intern is shell-only; other leaves do not spawn", () => {
    expect(DIRECTOR_REGISTRY.implement.tools?.allow).toEqual(
      expect.arrayContaining(["write_file", "edit_file", "delete_file"]),
    );
    const internAllow = DIRECTOR_REGISTRY.intern.tools?.allow ?? [];
    expect(internAllow).toContain("run_shell");
    expect(internAllow).not.toContain("write_file");
    expect(internAllow).not.toContain("edit_file");
    for (const id of DIRECTOR_IDS) {
      if (id === "skywalker" || id === "greybeard") continue;
      expect(DIRECTOR_REGISTRY[id].spawn.maySpawn).toBe(false);
    }
  });

  test("skywalker primary stance: never implement, no product write tools", () => {
    const s = DIRECTOR_REGISTRY.skywalker;
    expect(s.systemPrompt).toContain("NEVER implement");
    expect(s.systemPrompt).toMatch(/No general leaf/i);
    expect(s.tools?.allow).toContain("task");
    expect(s.tools?.allow).not.toContain("write_file");
    expect(s.spawn.allowlist).toHaveLength(15);
  });
});
