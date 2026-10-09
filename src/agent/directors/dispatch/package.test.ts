import { describe, expect, test } from "bun:test";

import {
  director,
  tools,
  config,
  systemPrompt,
} from "@corbits/code-agent-dispatch";
import { DISPATCH_TOOLS } from "../tool-sets.js";
import { DIRECTOR_REGISTRY } from "../registry.js";
import type { DirectorPackage } from "../types.js";

describe("dispatchPackage", () => {
  test("workspace package satisfies the director contract and feeds the registry", () => {
    const asDirector: DirectorPackage = director;
    expect(asDirector.id).toBe("dispatch");
    expect(DIRECTOR_REGISTRY.dispatch).toBe(director);
    expect([...director.tools.allow]).toEqual([...DISPATCH_TOOLS]);
    expect(new Set(director.tools.allow).size).toBe(
      director.tools.allow.length,
    );
  });

  test("spawn/tier/modelRole match config (Tier-1 orchestrator)", () => {
    expect(director.spawn).toEqual(config.spawn);
    expect(director.tier).toBe(config.tier);
    expect(director.modelRole).toBe(config.modelRole);
    expect(director.spawn.maySpawn).toBe(true);
    expect(director.tier).toBe("orchestrator");
    expect(director.modelRole).toBe("orchestrator");
  });

  test("prompt authority is byte-stable", () => {
    expect(director.systemPrompt).toBe(systemPrompt.build());
    expect(systemPrompt.build()).toBe(systemPrompt.build());
  });

  test("tools surface matches DISPATCH_TOOLS and is orchestration-scoped", () => {
    expect([...tools]).toEqual([...DISPATCH_TOOLS]);
    // Orchestration surface: search_agents IS present, wait_agents is NOT.
    expect(tools).toContain("search_agents");
    expect(tools).not.toContain("wait_agents");
    expect(tools).not.toContain("ask_operator");
    expect(tools).toContain("spawn_agent");
  });

  test("tools allowlist has no duplicates", () => {
    expect(new Set([...tools]).size).toBe(tools.length);
  });
});
