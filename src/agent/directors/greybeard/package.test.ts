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

  test("systemPrompt frames value as analysis via Corbits read tools", () => {
    const p = greybeardPackage.systemPrompt;
    expect(p).toMatch(/value is analysis/i);
    expect(p).toContain("read_file");
    expect(p).toContain("grep");
    expect(p).toContain("ask_director");
  });

  test("systemPrompt carries an ordered review checklist", () => {
    const p = greybeardPackage.systemPrompt;
    expect(p).toMatch(/Review checklist/);
    expect(p).toMatch(/architectural claim/);
    expect(p).toMatch(/constraint ownership|owns constraints/i);
    expect(p).toMatch(/anti-patterns/);
    expect(p).toMatch(/Rank risks/);
    const checklistIdx = p.search(/Review checklist/);
    expect(checklistIdx).toBeGreaterThan(-1);
    const checklist = p.slice(checklistIdx);
    const claimIdx = checklist.search(/architectural claim/);
    const ownershipIdx = checklist.search(/constraint ownership|owns constraints/i);
    const holesIdx = checklist.search(/anti-patterns/);
    const risksIdx = checklist.search(/Rank risks/);
    const verdictIdx = checklist.search(/hold \/ revise \/ block/);
    expect(claimIdx).toBeGreaterThan(-1);
    expect(ownershipIdx).toBeGreaterThan(claimIdx);
    expect(holesIdx).toBeGreaterThan(ownershipIdx);
    expect(risksIdx).toBeGreaterThan(holesIdx);
    expect(verdictIdx).toBeGreaterThan(risksIdx);
  });

  test("systemPrompt ends the checklist with the hold/revise/block verdict triad", () => {
    const p = greybeardPackage.systemPrompt;
    expect(p).toMatch(/hold \/ revise \/ block/);
    expect(p).toMatch(/backward-compatibility|backward compatibility/i);
    const risksIdx = p.search(/Rank risks/);
    const triadIdx = p.search(/hold \/ revise \/ block/);
    expect(risksIdx).toBeGreaterThan(-1);
    expect(triadIdx).toBeGreaterThan(risksIdx);
  });

  test("systemPrompt has no self-spawn language", () => {
    const p = greybeardPackage.systemPrompt;
    expect(p).not.toMatch(/spawn.*greybeard/i);
    expect(p).not.toContain('agent="greybeard"');
    expect(p).not.toMatch(/spawn yourself/i);
    expect(p).not.toMatch(/spawn a (greybeard|reviewer)/i);
  });

  test("systemPrompt allows limited spawn without fake caps or scheduler language", () => {
    const p = greybeardPackage.systemPrompt;
    expect(p).toMatch(/intern/);
    expect(p).toMatch(/explorer/);
    expect(p).toMatch(/critic/);
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

  test("systemPrompt requires success_criteria when spawning critic", () => {
    const p = greybeardPackage.systemPrompt;
    expect(p).toContain("success_criteria");
    expect(p).toMatch(/When spawning critic/);
    expect(p).toMatch(/fail-closes without it/);
    expect(p).toMatch(/intern and explorer remain optional/);
  });

  test("systemPrompt forbids spawning builder and names off-list directors", () => {
    expect(greybeardPackage.systemPrompt).toContain("Do not spawn builder");
    expect(greybeardPackage.systemPrompt).not.toMatch(/\bspawn implement\b/);
  });

  test("spawn.maySpawn is true with limited allowlist", () => {
    expect(greybeardPackage.spawn.maySpawn).toBe(true);
    expect(greybeardPackage.spawn.allowlist).toEqual([
      "intern",
      "explorer",
      "critic",
    ]);
  });

  test("allowlist is only intern, explorer, critic", () => {
    const allow = greybeardPackage.spawn.allowlist ?? [];
    expect(allow).toHaveLength(3);
    expect(allow).toContain("intern");
    expect(allow).toContain("explorer");
    expect(allow).toContain("critic");
    expect(allow).not.toContain("implement");
    expect(allow).not.toContain("builder");
    expect(allow).not.toContain("skywalker");
    expect(allow).not.toContain("counsel");
  });

  test("tools.allow is orchestrator surface with product writes but without fleet discovery", () => {
    const allow = greybeardPackage.tools?.allow ?? [];
    expect(allow).not.toContain("task");
    expect(allow).toContain("spawn_agent");
    expect(allow).toContain("wait_agents");
    // CL-7051: search_agents is Skywalker-only — nested directors spawn from allowlist.
    expect(allow).not.toContain("search_agents");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("modelRole is review", () => {
    expect(greybeardPackage.modelRole).toBe("review");
  });

  test("optionalSkills order", () => {
    expect(greybeardPackage.optionalSkills).toEqual([
      "style",
      "philosophy",
      "native-integration",
    ]);
  });

  test("primaryIntent and outOfLane match greybeard lane", () => {
    expect(greybeardPackage.primaryIntent).toBe(
      "Architecture judgment; limited spawn",
    );
    expect(greybeardPackage.outOfLane).toContain("shipping product code");
    expect(greybeardPackage.outOfLane).toContain(
      "pedantic style-only nitpicking",
    );
  });
});
