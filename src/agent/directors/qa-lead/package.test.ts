import { describe, expect, test } from "bun:test";

import { REVIEW_TOOLS } from "../tool-sets.js";
import { DIRECTOR_REGISTRY } from "../registry.js";
import { qaLeadPackage } from "./package.js";
import type { DirectorPackage } from "../types.js";
import { defined } from "../../../../testkit/defined.js";

describe("qaLeadPackage", () => {
  test("package shape satisfies the director contract and feeds the registry", () => {
    const asDirector: DirectorPackage = qaLeadPackage;
    expect(asDirector.id).toBe("qa-lead");
    expect(DIRECTOR_REGISTRY["qa-lead"]).toBe(qaLeadPackage);
  });

  test("tools surface matches REVIEW_TOOLS and is leaf-scoped", () => {
    const allow = defined(qaLeadPackage.tools?.allow);
    expect([...allow]).toEqual([...REVIEW_TOOLS]);
    expect(new Set(allow).size).toBe(allow.length);
    expect(
      (defined(qaLeadPackage.tools) as { deny?: unknown }).deny,
    ).toBeUndefined();
    expect(allow).not.toContain("spawn_agent");
    expect(allow).not.toContain("wait_agents");
    expect(allow).not.toContain("search_agents");
  });

  test("hands-on leaf: no spawn, test model role", () => {
    expect(qaLeadPackage.spawn.maySpawn).toBe(false);
    expect(qaLeadPackage.tier).toBe("leaf");
    expect(qaLeadPackage.modelRole).toBe("test");
  });
});
