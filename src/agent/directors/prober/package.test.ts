import { describe, expect, test } from "bun:test";

import { proberPackage } from "@corbits/agent-prober";
import { REVIEW_TOOLS } from "../tool-sets.js";
import { DIRECTOR_REGISTRY } from "../registry.js";
import type { DirectorPackage } from "../types.js";

describe("proberPackage", () => {
  test("workspace package satisfies the director contract and feeds the registry", () => {
    const asDirector: DirectorPackage = proberPackage;
    expect(asDirector.id).toBe("prober");
    expect(DIRECTOR_REGISTRY.prober).toBe(proberPackage);
    expect([...proberPackage.tools.allow]).toEqual([...REVIEW_TOOLS]);
  });

  test("extracted copy stays measure-only and non-spawning", () => {
    expect(proberPackage.tools.allow).toContain("read_file");
    expect(proberPackage.tools.allow).toContain("grep");
    expect(proberPackage.tools.allow).not.toContain("spawn_agent");
    expect(proberPackage.tools.allow).not.toContain("ask_operator");
    expect(proberPackage.spawn.maySpawn).toBe(false);
    expect(proberPackage.tier).toBe("leaf");
    expect(proberPackage.modelRole).toBe("test");
  });
});
