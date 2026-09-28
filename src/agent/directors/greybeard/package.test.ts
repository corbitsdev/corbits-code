import { describe, expect, test } from "bun:test";
import { REVIEW_TOOLS } from "../tool-sets.js";
import { greybeardPackage } from "./package.js";

describe("greybeardPackage", () => {
  test("systemPrompt has no self-spawn language", () => {
    const p = greybeardPackage.systemPrompt;
    expect(p).not.toMatch(/spawn.*greybeard/i);
    expect(p).not.toContain('agent="greybeard"');
    expect(p).not.toMatch(/spawn yourself/i);
    expect(p).not.toMatch(/spawn a (greybeard|reviewer)/i);
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
  });

  test("modelRole is review", () => {
    expect(greybeardPackage.modelRole).toBe("review");
  });

  test("attachedSkills are style and philosophy; optionalSkills are on-demand", () => {
    expect(greybeardPackage.attachedSkills).toEqual(["style", "philosophy"]);
    expect(greybeardPackage.optionalSkills).toEqual(["native-integration"]);
  });

  test("primaryIntent and outOfLane match greybeard lane", () => {
    expect(greybeardPackage.primaryIntent).toBe("Architecture judgment");
    expect(greybeardPackage.outOfLane).toContain("shipping product code");
    expect(greybeardPackage.outOfLane).toContain(
      "pedantic style-only nitpicking",
    );
  });
});
