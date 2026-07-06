import { describe, expect, test } from "bun:test";
import { createAgentIndex, formatAgentSearchResults } from "./agent-search.js";
import type { AgentProfile } from "./profiles.js";

const fixtures: AgentProfile[] = [
  {
    id: "greybeard",
    description: "Seasoned architect — reviews for design and backwards compatibility",
    tier: "clever",
  },
  {
    id: "critique",
    description: "Code quality reviewer — tests assumptions and security smells",
    tier: "standard",
  },
  {
    id: "scout",
    description: "Fast codebase explorer — maps structure and entry points",
    tier: "fast",
  },
];

describe("createAgentIndex", () => {
  test("review team returns both reviewers", () => {
    const index = createAgentIndex(() => fixtures);
    const hits = index.search("review team");
    const ids = hits.map((p) => p.id);
    expect(ids).toContain("greybeard");
    expect(ids).toContain("critique");
    expect(ids).not.toContain("scout");
  });

  test("architect favors greybeard", () => {
    const index = createAgentIndex(() => fixtures);
    const hits = index.search("architect");
    expect(hits[0]?.id).toBe("greybeard");
  });
});

describe("formatAgentSearchResults", () => {
  test("includes task hint and ids", () => {
    const text = formatAgentSearchResults([fixtures[1]!]);
    expect(text).toContain("critique");
    expect(text).toContain("task(agent=");
  });
});