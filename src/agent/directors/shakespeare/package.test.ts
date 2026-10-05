import { describe, expect, test } from "bun:test";

import { shakespearePackage } from "@corbits/agent-shakespeare";
import { DOCS_TOOLS } from "../tool-sets.js";
import { DIRECTOR_REGISTRY } from "../registry.js";
import type { DirectorPackage } from "../types.js";

describe("shakespearePackage", () => {
  test("workspace package satisfies the director contract and feeds the registry", () => {
    const asDirector: DirectorPackage = shakespearePackage;
    expect(asDirector.id).toBe("shakespeare");
    expect(DIRECTOR_REGISTRY.shakespeare).toBe(shakespearePackage);
    expect([...shakespearePackage.tools.allow]).toEqual([...DOCS_TOOLS]);
  });

  test("extracted copy stays docs-scoped and non-spawning", () => {
    expect(shakespearePackage.tools.allow).toContain("write_file");
    expect(shakespearePackage.tools.allow).toContain("edit_file");
    expect(shakespearePackage.tools.allow).toContain("delete_file");
    expect(shakespearePackage.tools.allow).not.toContain("run_shell");
    expect(shakespearePackage.tools.allow).not.toContain("spawn_agent");
    expect(shakespearePackage.tools.allow).not.toContain("ask_operator");
    expect(shakespearePackage.spawn.maySpawn).toBe(false);
    expect(shakespearePackage.tier).toBe("leaf");
    expect(shakespearePackage.modelRole).toBe("docs");
  });
});
