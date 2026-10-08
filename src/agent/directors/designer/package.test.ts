import { describe, expect, test } from "bun:test";

import { designerPackage } from "@corbits/code-agent-designer";
import { BUILD_TOOLS } from "../tool-sets.js";
import { DIRECTOR_REGISTRY } from "../registry.js";
import type { DirectorPackage } from "../types.js";

describe("designerPackage", () => {
  test("workspace package satisfies the director contract and feeds the registry", () => {
    const asDirector: DirectorPackage = designerPackage;
    expect(asDirector.id).toBe("designer");
    expect(DIRECTOR_REGISTRY.designer).toBe(designerPackage);
    expect([...designerPackage.tools.allow]).toEqual([...BUILD_TOOLS]);
  });

  test("extracted copy stays build-scoped and non-spawning", () => {
    expect(designerPackage.tools.allow).toContain("write_file");
    expect(designerPackage.tools.allow).toContain("edit_file");
    expect(designerPackage.tools.allow).toContain("delete_file");
    expect(designerPackage.tools.allow).not.toContain("spawn_agent");
    expect(designerPackage.tools.allow).not.toContain("ask_operator");
    expect(designerPackage.spawn.maySpawn).toBe(false);
    expect(designerPackage.tier).toBe("leaf");
    expect(designerPackage.modelRole).toBe("implement");
  });
});
