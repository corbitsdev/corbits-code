import { describe, expect, test } from "bun:test";

import {
  director,
  tools,
  config,
  systemPrompt,
} from "@corbits/code-agent-designer";
import { REVIEW_TOOLS } from "../tool-sets.js";
import { DIRECTOR_REGISTRY } from "../registry.js";
import type { DirectorPackage } from "../types.js";

describe("designerPackage", () => {
  test("workspace package satisfies the director contract and feeds the registry", () => {
    const asDirector: DirectorPackage = director;
    expect(asDirector.id).toBe("designer");
    expect(DIRECTOR_REGISTRY.designer).toBe(director);
    expect([...director.tools.allow]).toEqual([...REVIEW_TOOLS]);
    expect(new Set(director.tools.allow).size).toBe(
      director.tools.allow.length,
    );
  });

  test("spawn/tier/modelRole match config", () => {
    expect(director.spawn).toEqual(config.spawn);
    expect(director.tier).toBe(config.tier);
    expect(director.modelRole).toBe(config.modelRole);
    expect(director.spawn.maySpawn).toBe(false);
    expect(director.tier).toBe("leaf");
    expect(director.modelRole).toBe("implement");
  });

  test("prompt authority is byte-stable", () => {
    expect(director.systemPrompt).toBe(systemPrompt.build());
    expect(systemPrompt.build()).toBe(systemPrompt.build());
  });

  test("tools surface matches REVIEW_TOOLS and is leaf-scoped", () => {
    expect([...tools]).toEqual([...REVIEW_TOOLS]);
    expect(tools).not.toContain("spawn_agent");
    expect(tools).not.toContain("ask_operator");
    expect(tools).not.toContain("wait_agents");
    expect(tools).not.toContain("search_agents");
  });

  test("tools allowlist has no duplicates", () => {
    expect(new Set([...tools]).size).toBe(tools.length);
  });
});
