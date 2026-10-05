import { describe, expect, test } from "bun:test";

import { wardenPackage } from "@corbits/agent-warden";
import { REVIEW_TOOLS } from "../tool-sets.js";
import { DIRECTOR_REGISTRY } from "../registry.js";
import type { DirectorPackage } from "../types.js";

describe("wardenPackage", () => {
  test("workspace package satisfies the director contract and feeds the registry", () => {
    const asDirector: DirectorPackage = wardenPackage;
    expect(asDirector.id).toBe("warden");
    expect(DIRECTOR_REGISTRY.warden).toBe(wardenPackage);
    expect([...wardenPackage.tools.allow]).toEqual([...REVIEW_TOOLS]);
  });

  test("extracted copy stays trust-review-scoped and non-spawning", () => {
    expect(wardenPackage.tools.allow).toContain("read_file");
    expect(wardenPackage.tools.allow).toContain("grep");
    expect(wardenPackage.tools.allow).not.toContain("spawn_agent");
    expect(wardenPackage.tools.allow).not.toContain("ask_operator");
    expect(wardenPackage.spawn.maySpawn).toBe(false);
    expect(wardenPackage.tier).toBe("leaf");
    expect(wardenPackage.modelRole).toBe("review");
  });
});
