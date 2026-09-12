import { describe, expect, test } from "bun:test";
import { gaasbotPackage } from "./package.js";

describe("gaasbotPackage", () => {
  test("id matches directory (keep gaasbot path; identity is Gaasbot)", () => {
    expect(gaasbotPackage.id).toBe("gaasbot");
  });

  test("systemPrompt is real (not Placeholder)", () => {
    expect(gaasbotPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(gaasbotPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(gaasbotPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
  });

  test("systemPrompt identity is Gaasbot / GaasbotDirector (risk counsel)", () => {
    const p = gaasbotPackage.systemPrompt;
    expect(p).toMatch(/GaasbotDirector \(Gaasbot\)/);
    expect(p).toMatch(/risk-counsel lane only|risk counsel/i);
    expect(p).not.toMatch(/CTO advice leaf/i);
  });

  test("systemPrompt teaches sequencing / ship-risk buckets", () => {
    const p = gaasbotPackage.systemPrompt;
    expect(p).toMatch(/blocks a release|blocks a ship/i);
    expect(p).toMatch(/ship with (an )?explicit note|ships with a note/i);
    expect(p).toMatch(/filed for later/i);
    expect(p).toMatch(/most likely getting wrong/i);
    expect(p).toMatch(/do not ship/i);
    expect(p).toMatch(/not a hard gate/i);
  });

  test("systemPrompt is blinders-on risk counsel (no implement / gate / plan / orchestrate)", () => {
    const p = gaasbotPackage.systemPrompt;
    expect(p).toMatch(/Blinders on/i);
    expect(p).toMatch(/Do not spawn specialists/i);
    expect(p).toMatch(/not Builder/i);
    expect(p).toMatch(/not Critic/i);
    expect(p).toMatch(/not Greybeard/i);
    expect(p).toMatch(/not Counsel/i);
    expect(p).toMatch(/not an orchestrator/i);
  });

  test("systemPrompt has DONE GATE for risk ask completeness", () => {
    const p = gaasbotPackage.systemPrompt;
    expect(p).toContain("DONE GATE");
    expect(p).toMatch(/[Ss]top when/);
    expect(p).toContain("Blockers");
  });

  test("systemPrompt has no tool-schema restatement or fake caps", () => {
    const p = gaasbotPackage.systemPrompt;
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/fan-out/i);
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/turn budget/i);
    expect(p).not.toMatch(/scheduler/i);
    expect(p).not.toMatch(/Prefer grep\/search_files/i);
    expect(p).not.toMatch(/Shell find\/rg/i);
    expect(p).not.toMatch(/Write tools are not mounted/i);
    expect(p).not.toMatch(/via run_shell/i);
  });

  test("spawn.maySpawn is false", () => {
    expect(gaasbotPackage.spawn.maySpawn).toBe(false);
  });

  test("mounts product write tools (lane discipline in prompts)", () => {
    const allow = gaasbotPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("modelRole is plan", () => {
    expect(gaasbotPackage.modelRole).toBe("plan");
  });

  test("optionalSkills is style, philosophy, and native-integration", () => {
    expect(gaasbotPackage.optionalSkills).toEqual([
      "style",
      "philosophy",
      "native-integration",
    ]);
  });

  test("systemPrompt carries the CTO voice strands (contract, not phrasing)", () => {
    const p = gaasbotPackage.systemPrompt;
    expect(p).toMatch(/squash PR commits/i);
    expect(p).toMatch(/hooks must be on/i);
    expect(p).toMatch(/loose coupling|composability/i);
    expect(p).toMatch(/owns the constraint|owning layer/i);
    expect(p).toMatch(/statically-typed|static types/i);
    expect(p).toMatch(/Push back when/i);
    expect(p).toMatch(/Stay flexible when/i);
    expect(p).toMatch(/symptom-chasing/i);
    expect(p).toMatch(/parent\/operator/i);
  });

  test("CTO voice grants no ship/implement/merge-block/spawn powers", () => {
    const p = gaasbotPackage.systemPrompt;
    expect(p).not.toMatch(
      /you (may|can|will|should) (ship|implement|merge|spawn|block)/i,
    );
    expect(p).not.toMatch(/go ahead and (ship|implement|merge)/i);
    expect(p).not.toMatch(/merge-block(ing|er)? (powers|authority)/i);
    expect(p).not.toMatch(/act as (a|the) (gate|implementer|orchestrator)/i);
  });

  test("primaryIntent and outOfLane match risk counsel lane", () => {
    expect(gaasbotPackage.primaryIntent).toMatch(/[Rr]isk counsel/i);
    expect(gaasbotPackage.description).toMatch(/[Rr]isk counsel/i);
    expect(gaasbotPackage.outOfLane).toContain("blocking merges");
    expect(gaasbotPackage.outOfLane).toContain(
      "shipping product code as implementer",
    );
    expect(gaasbotPackage.outOfLane).toContain(
      "replacing greybeard architecture review",
    );
    expect(gaasbotPackage.outOfLane).toContain(
      "replacing plan eng change plans",
    );
    expect(gaasbotPackage.outOfLane).toContain("applying product fixes");
  });
});
