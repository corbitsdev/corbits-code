import { describe, expect, test } from "bun:test";
import { greybeardPackage } from "./package.js";

describe("greybeardPackage", () => {
  test("id matches directory", () => {
    expect(greybeardPackage.id).toBe("greybeard");
  });

  test("systemPrompt is non-empty and not a Placeholder", () => {
    expect(greybeardPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(greybeardPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt mentions PRIMARY INTENT", () => {
    expect(greybeardPackage.systemPrompt).toContain("PRIMARY INTENT");
  });

  test("systemPrompt identity is Greybeard / GreybeardDirector (not job-title language)", () => {
    const p = greybeardPackage.systemPrompt;
    expect(p).toMatch(/GreybeardDirector \(Greybeard\)/);
    expect(p).toMatch(/architecture judgment/i);
    expect(p).not.toMatch(/architecture director/i);
  });

  test("systemPrompt teaches judgment for architecture approach", () => {
    const p = greybeardPackage.systemPrompt;
    expect(p).toContain("Judge the approach");
    expect(p).toMatch(/constraint ownership|owns constraints/i);
    expect(p).toMatch(/hold \/ revise \/ block|verdict/i);
    expect(p).toMatch(/backward-compatibility|backward compatibility/i);
  });

  test("systemPrompt allows limited spawn without fake caps or scheduler language", () => {
    const p = greybeardPackage.systemPrompt;
    expect(p).toMatch(/intern/);
    expect(p).toMatch(/explore/);
    expect(p).toMatch(/critique/);
    expect(p).toMatch(/Prefer doing the review yourself/i);
    expect(p).toMatch(/Do not invent numeric spawn caps|not a soft ladder/i);
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/spawn at most one/i);
    expect(p).not.toMatch(/parallel diagnostic fleet/i);
    expect(p).not.toMatch(/turn budget/i);
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/fan-out/i);
  });

  test("systemPrompt has Blinders against search_agents fleet discovery", () => {
    const p = greybeardPackage.systemPrompt;
    expect(p).toMatch(/Blinders/i);
    expect(p).toMatch(/do not call search_agents/i);
    expect(p).toMatch(/even when nested/i);
  });

  test("systemPrompt guides quality without enforcement theater", () => {
    const p = greybeardPackage.systemPrompt;
    expect(p).toMatch(/Guide quality/i);
    expect(p).toMatch(/enforcement theater/i);
  });

  test("systemPrompt distinguishes Greybeard from Critic and Builder (series naming)", () => {
    const p = greybeardPackage.systemPrompt;
    expect(p).toMatch(/not Critic/);
    expect(p).toMatch(/not Builder/);
    expect(p).not.toMatch(/not Critique/);
    expect(p).not.toMatch(/not Build\b/);
  });

  test("systemPrompt forbids spawning build and names off-list directors", () => {
    expect(greybeardPackage.systemPrompt).toContain("Do not spawn build");
    expect(greybeardPackage.systemPrompt).not.toMatch(/\bspawn implement\b/);
  });

  test("spawn.maySpawn is true with limited allowlist", () => {
    expect(greybeardPackage.spawn.maySpawn).toBe(true);
    expect(greybeardPackage.spawn.allowlist).toEqual(["intern", "explore", "critique"]);
  });

  test("allowlist is only intern, explore, critique", () => {
    const allow = greybeardPackage.spawn.allowlist ?? [];
    expect(allow).toHaveLength(3);
    expect(allow).toContain("intern");
    expect(allow).toContain("explore");
    expect(allow).toContain("critique");
    expect(allow).not.toContain("implement");
    expect(allow).not.toContain("build");
    expect(allow).not.toContain("skywalker");
    expect(allow).not.toContain("plan");
  });

  test("tools.allow is orchestrator surface without product writes", () => {
    const allow = greybeardPackage.tools?.allow ?? [];
    expect(allow).toContain("task");
    expect(allow).toContain("search_agents");
    expect(allow).not.toContain("write_file");
    expect(allow).not.toContain("edit_file");
    expect(allow).not.toContain("delete_file");
  });

  test("modelRole is review", () => {
    expect(greybeardPackage.modelRole).toBe("review");
  });

  test("optionalSkills order", () => {
    expect(greybeardPackage.optionalSkills).toEqual(["style", "philosophy"]);
  });

  test("primaryIntent and outOfLane match greybeard lane", () => {
    expect(greybeardPackage.primaryIntent).toBe("Architecture judgment; limited spawn");
    expect(greybeardPackage.outOfLane).toContain("shipping product code");
    expect(greybeardPackage.outOfLane).toContain("pedantic style-only nitpicking");
  });
});
