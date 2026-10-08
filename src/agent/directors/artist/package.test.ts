import { describe, expect, test } from "bun:test";

import { artistPackage } from "@corbits/code-agent-artist";
import { PRODUCT_WRITE_TOOLS, READ_TOOLS } from "../tool-sets.js";
import { DIRECTOR_REGISTRY } from "../registry.js";
import type { DirectorPackage } from "../types.js";

describe("artistPackage", () => {
  test("workspace package satisfies the director contract and feeds the registry", () => {
    const asDirector: DirectorPackage = artistPackage;
    expect(asDirector.id).toBe("artist");
    expect(DIRECTOR_REGISTRY.artist).toBe(artistPackage);
    expect([...artistPackage.tools.allow]).toEqual([
      ...READ_TOOLS,
      ...PRODUCT_WRITE_TOOLS,
    ]);
  });

  test("extracted copy stays visual-scoped and non-spawning", () => {
    expect(artistPackage.tools.allow).toContain("write_file");
    expect(artistPackage.tools.allow).toContain("edit_file");
    expect(artistPackage.tools.allow).toContain("delete_file");
    expect(artistPackage.tools.allow).not.toContain("spawn_agent");
    expect(artistPackage.tools.allow).not.toContain("ask_operator");
    expect(artistPackage.spawn.maySpawn).toBe(false);
    expect(artistPackage.tier).toBe("leaf");
    expect(artistPackage.modelRole).toBe("implement");
  });
});
