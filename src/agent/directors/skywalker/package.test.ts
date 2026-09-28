import { describe, expect, test } from "bun:test";
import { skywalkerPackage } from "./package.js";

describe("skywalkerPackage", () => {
  test("dispatcher card stays in the 3–5k band", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p.length).toBeGreaterThanOrEqual(3000);
    expect(p.length).toBeLessThanOrEqual(5000);
  });

  test("idle, mailbox, and poll stay out of the card", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).not.toMatch(/idle/i);
    expect(p).not.toMatch(/mailbox/i);
    expect(p).not.toMatch(/\bpoll\b/i);
    expect(p).not.toContain("wait_agents");
  });

  test("card is not a Karen clone", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).not.toMatch(/karen/i);
    expect(p).not.toContain("section 9");
    expect(p).not.toContain("You orchestrate.");
  });

  test("spawn allowlist is the full closed set", () => {
    expect(skywalkerPackage.spawn.allowlist).toHaveLength(19);
    expect(skywalkerPackage.spawn.allowlist).toEqual([
      "builder",
      "explorer",
      "counsel",
      "intern",
      "critic",
      "greybeard",
      "neckbeard",
      "bruckheimer",
      "gaasbot",
      "draper",
      "emil",
      "rand",
      "shakespeare",
      "testsmith",
      "tester",
      "gauntlet",
      "prober",
      "migrator",
      "warden",
    ]);
  });

  test("tools.allow mounts agent search for DIY delegation", () => {
    const allow = skywalkerPackage.tools?.allow ?? [];
    expect(allow).toContain("search_agents");
  });

  test("modelRole is orchestrator", () => {
    expect(skywalkerPackage.modelRole).toBe("orchestrator");
  });

  test("optionalSkills order", () => {
    expect(skywalkerPackage.optionalSkills).toEqual([
      "style",
      "philosophy",
      "native-integration",
      "interview",
    ]);
    expect(skywalkerPackage.attachedSkills).toBeUndefined();
  });

  test("systemPrompt has no Ponytail routing or mode internals", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).not.toMatch(/ponytail/i);
    expect(p).not.toContain("Default to `lite`");
    expect(p).not.toContain("Escalation ladder");
  });

  test("primaryIntent and outOfLane", () => {
    expect(skywalkerPackage.primaryIntent).toBe(
      "Orchestrate; DIY tiny/bounded product edits; spawn for substantial work",
    );
    expect(skywalkerPackage.outOfLane).toContain(
      "substantial multi-file product work without spawning",
    );
    expect(skywalkerPackage.outOfLane).toContain("catch-all worker");
    expect(skywalkerPackage.outOfLane).toContain(
      "searching the repo yourself after a worker stops without finishing",
    );
    expect(skywalkerPackage.outOfLane).toContain(
      "diagnostic fleets for why/how/stall questions",
    );
  });

  test("systemPrompt does not forbid steering workers when the operator messages mid-run", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).not.toContain("answer them first");
    expect(p).not.toContain("Do not hold the reply on fleet collection");
  });

  test("systemPrompt does not use leaf jargon", () => {
    expect(skywalkerPackage.systemPrompt).not.toMatch(/\bleaf\b/i);
    expect(skywalkerPackage.systemPrompt).not.toMatch(/\bleaves\b/i);
  });
});
