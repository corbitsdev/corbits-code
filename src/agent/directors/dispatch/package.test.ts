import { describe, expect, test } from "bun:test";

import { dispatchPackage } from "@corbits/agent-dispatch";
import { DISPATCH_TOOLS } from "../tool-sets.js";
import { DIRECTOR_REGISTRY } from "../registry.js";
import type { DirectorPackage } from "../types.js";

describe("dispatchPackage", () => {
  test("workspace package satisfies the director contract and feeds the registry", () => {
    const asDirector: DirectorPackage = dispatchPackage;
    expect(asDirector.id).toBe("dispatch");
    expect(DIRECTOR_REGISTRY.dispatch).toBe(dispatchPackage);
    expect([...dispatchPackage.tools.allow]).toEqual([...DISPATCH_TOOLS]);
  });

  test("extracted copy stays orchestrator-scoped and spawning", () => {
    expect(dispatchPackage.tools.allow).toContain("spawn_agent");
    expect(dispatchPackage.tools.allow).toContain("search_agents");
    expect(dispatchPackage.spawn.maySpawn).toBe(true);
    expect(dispatchPackage.spawn.allowlist).toEqual([
      "explorer",
      "planner",
      "coder",
      "reviewer",
      "designer",
      "artist",
      "warden",
      "shakespeare",
      "prober",
      "qa-lead",
    ]);
    expect(dispatchPackage.tier).toBe("orchestrator");
    expect(dispatchPackage.modelRole).toBe("orchestrator");
  });
});
