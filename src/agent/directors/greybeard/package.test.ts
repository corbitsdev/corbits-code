import { describe, expect, test } from "bun:test";
import { REVIEW_TOOLS } from "../tool-sets.js";
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
    const ownershipIdx = checklist.search(
      /constraint ownership|owns constraints/i,
    );
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

  test("systemPrompt is a leaf worker: no spawn path, no fake caps or scheduler language", () => {
    const p = greybeardPackage.systemPrompt;
    expect(p).toMatch(/you cannot spawn/i);
    expect(p).toMatch(/leaf worker/i);
    expect(p).toMatch(/no fleet verbs are mounted/i);
    expect(p).toMatch(/Prefer doing the review yourself/i);
    expect(p).toMatch(/Do not invent numeric spawn caps|not a soft ladder/i);
    expect(p).not.toMatch(/Spawn only when/i);
    expect(p).not.toMatch(/Package spawn rules/i);
    expect(p).not.toMatch(/Spawn then idle/i);
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/spawn at most one/i);
    expect(p).not.toMatch(/parallel diagnostic fleet/i);
    expect(p).not.toMatch(/turn budget/i);
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/fan-out/i);
  });

  test("systemPrompt has Blinders against fleet discovery and any spawn", () => {
    const p = greybeardPackage.systemPrompt;
    expect(p).toMatch(/Blinders/i);
    expect(p).toMatch(/do not call search_agents/i);
    expect(p).toMatch(/not an orchestrator/i);
    expect(p).toMatch(/Do not spawn builder/);
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

  test("systemPrompt routes blocking unknowns to Blockers/ask_director instead of spawn", () => {
    const p = greybeardPackage.systemPrompt;
    expect(p).toMatch(/When a concrete unknown blocks the judgment/);
    expect(p).toMatch(/name it under Blockers/);
    expect(p).toContain("ask_director");
    expect(p).not.toMatch(/When spawning critic/);
    expect(p).not.toMatch(/success_criteria/);
  });

  test("systemPrompt forbids spawning builder and names off-list directors", () => {
    expect(greybeardPackage.systemPrompt).toContain("Do not spawn builder");
    expect(greybeardPackage.systemPrompt).not.toMatch(/\bspawn implement\b/);
  });

  test("spawn.maySpawn is false (leaf)", () => {
    expect(greybeardPackage.spawn.maySpawn).toBe(false);
    expect(greybeardPackage.spawn.allowlist).toBeUndefined();
  });

  test("no spawn allowlist survives the leaf conversion", () => {
    expect(greybeardPackage.spawn.allowlist ?? []).toHaveLength(0);
  });

  test("tools.allow is the review surface without fleet verbs", () => {
    const allow = greybeardPackage.tools?.allow ?? [];
    expect([...allow]).toEqual([...REVIEW_TOOLS]);
    expect(allow).not.toContain("task");
    expect(allow).not.toContain("spawn_agent");
    expect(allow).not.toContain("wait_agents");
    // CL-7051: search_agents is Skywalker-only — leaves never mount discovery.
    expect(allow).not.toContain("search_agents");
    expect(allow).not.toContain("list_agents");
    expect(allow).not.toContain("send_input");
    expect(allow).toContain("read_file");
    expect(allow).toContain("grep");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("tier is leaf", () => {
    expect(greybeardPackage.tier).toBe("leaf");
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
    expect(greybeardPackage.primaryIntent).toBe("Architecture judgment");
    expect(greybeardPackage.outOfLane).toContain("shipping product code");
    expect(greybeardPackage.outOfLane).toContain(
      "pedantic style-only nitpicking",
    );
  });
});
