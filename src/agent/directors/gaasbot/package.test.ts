import { describe, expect, test } from "bun:test";
import { gaasbotPackage } from "./package.js";

describe("gaasbotPackage", () => {
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

  test("tools.allow mounts read", () => {
    const allow = gaasbotPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
  });

  test("modelRole is plan", () => {
    expect(gaasbotPackage.modelRole).toBe("plan");
  });

  test("attachedSkills are style and philosophy; optionalSkills are on-demand", () => {
    expect(gaasbotPackage.attachedSkills).toEqual(["style", "philosophy"]);
    expect(gaasbotPackage.optionalSkills).toEqual(["native-integration"]);
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

  test("new restored lines grant no ship/implement/merge-block/spawn powers", () => {
    const p = gaasbotPackage.systemPrompt;
    const sessionBlock = p.slice(
      p.indexOf("Session Initialization"),
      p.indexOf("PRIMARY INTENT"),
    );
    expect(sessionBlock).not.toMatch(
      /you (may|can|will|should) (ship|implement|merge|spawn|block)/i,
    );
    const advisoryLine =
      p.slice(p.indexOf("Before substantial advisory work")).split("\n")[0] ??
      "";
    expect(advisoryLine).not.toMatch(
      /you (may|can|will|should) (ship|implement|merge|spawn|block)/i,
    );
    expect(advisoryLine).not.toMatch(/go ahead and (ship|implement|merge)/i);
    expect(advisoryLine).not.toMatch(
      /act as (a|the) (gate|implementer|orchestrator)/i,
    );
  });
});
