import { describe, expect, test } from "bun:test";
import {
  createAgentIndex,
  createSearchAgentsTool,
  formatAgentSearchResults,
} from "./agent-search.js";
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

  test("includes source label when present", () => {
    const text = formatAgentSearchResults([
      {
        id: "marketplace-scout",
        description: "From Claude install",
        source: "claude",
      },
    ]);
    expect(text).toContain("[source: claude]");
    expect(text).toContain("marketplace-scout");
  });

  test("injects full system prompt body so parent need not read_file plugin roots", () => {
    const body =
      "You are draper. Review pull requests for design clarity and maintainability.\n" +
      "Prefer concrete file/line citations.";
    const text = formatAgentSearchResults([
      {
        id: "draper",
        description: "PR design reviewer from marketplace",
        source: "claude",
        tier: "standard",
        systemPromptRole: body,
      },
    ]);
    expect(text).toContain("### draper");
    expect(text).toContain("[source: claude]");
    expect(text).toContain("[tier: standard]");
    expect(text).toContain("System prompt / body:");
    expect(text).toContain(body);
    expect(text).toContain("do not need read_file on plugin roots");
  });

  test("omits body section when systemPromptRole is absent", () => {
    const text = formatAgentSearchResults([
      { id: "no-body", description: "Metadata only" },
    ]);
    expect(text).toContain("### no-body");
    expect(text).toContain("Metadata only");
    expect(text).not.toContain("System prompt / body:");
  });
});

describe("createSearchAgentsTool", () => {
  test("handler surfaces loaded systemPromptRole for plugin-style profiles", async () => {
    const body = "You are emil. Focus on product sense and user impact.";
    const tool = createSearchAgentsTool(() => [
      {
        id: "emil",
        description: "Product-minded reviewer",
        source: "claude",
        systemPromptRole: body,
      },
      {
        id: "greybeard",
        description: "Architect",
        systemPromptRole: "You are greybeard.",
      },
    ]);
    if (tool.kind !== "string") throw new Error("expected string tool");
    const text = await tool.handler(
      { query: "emil product" },
      new AbortController().signal,
    );
    expect(text).toContain("emil");
    expect(text).toContain("System prompt / body:");
    expect(text).toContain(body);
    expect(text).toContain("[source: claude]");
  });
});
