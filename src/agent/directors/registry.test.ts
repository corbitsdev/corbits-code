import { describe, expect, test } from "bun:test";

import { DIRECTOR_IDS } from "./types.js";
import {
  DIRECTOR_REGISTRY,
  INTENT_DEFAULT_DIRECTOR,
  isDirectorId,
  listDirectors,
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
});
