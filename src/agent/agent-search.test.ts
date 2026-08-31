import { describe, expect, test } from "bun:test";
import { CREDENTIAL_REDACTION } from "../plugins/tool-result-secret-scrub.js";
import {
  createAgentIndex,
  createSearchAgentsTool,
  formatAgentSearchResults,
  MAX_AGENT_SEARCH_BODY_CHARS,
} from "./agent-search.js";
import type { AgentProfile } from "./profiles.js";

const fixtures: AgentProfile[] = [
  {
    id: "greybeard",
    description: "Seasoned architect — reviews for design and backwards compatibility",
  },
  {
    id: "critique",
    description: "Code quality reviewer — tests assumptions and security smells",
  },
  {
    id: "scout",
    description: "Fast codebase explorer — maps structure and entry points",
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
  test("includes spawn hint and ids", () => {
    const text = formatAgentSearchResults([fixtures[1]!]);
    expect(text).toContain("critique");
    expect(text).toContain("spawn_agent(agent=");
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
        systemPromptRole: body,
      },
    ]);
    expect(text).toContain("### draper");
    expect(text).toContain("[source: claude]");
    expect(text).toContain("System prompt / body:");
    expect(text).toContain(body);
    expect(text).toContain("do not need read_file on plugin roots");
  });

  test("omits body section when systemPromptRole is absent", () => {
    const text = formatAgentSearchResults([{ id: "no-body", description: "Metadata only" }]);
    expect(text).toContain("### no-body");
    expect(text).toContain("Metadata only");
    expect(text).not.toContain("System prompt / body:");
  });

  test("truncates oversized systemPromptRole bodies with ellipsis marker", () => {
    const body = "x".repeat(MAX_AGENT_SEARCH_BODY_CHARS + 500);
    const text = formatAgentSearchResults([
      {
        id: "huge",
        description: "Oversized marketplace body",
        systemPromptRole: body,
      },
    ]);
    expect(text).toContain("System prompt / body:");
    expect(text).toContain("…[truncated]");
    expect(text).not.toContain(body);
    const bodySection = text.split("System prompt / body:\n")[1] ?? "";
    const injected = bodySection.split("\n\nSpawn with")[0] ?? bodySection;
    expect(injected.length).toBeLessThan(body.length);
    expect(injected.startsWith("x".repeat(MAX_AGENT_SEARCH_BODY_CHARS))).toBe(true);
  });

  test("redacts secret-shaped content in profile body at format layer", () => {
    // search_agents is not on the posix middleware path; scrub must happen here.
    const secret = "sk-live-abc123xyz789012345678";
    const text = formatAgentSearchResults([
      {
        id: "leaky",
        description: "Profile with credential-shaped body text",
        source: "claude",
        systemPromptRole: `Use API_KEY=${secret} when calling the provider.`,
      },
    ]);
    expect(text).toContain("### leaky");
    expect(text).toContain("System prompt / body:");
    expect(text).toContain(CREDENTIAL_REDACTION);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("sk-live-abc123");
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
    const text = await tool.handler({ query: "emil product" }, new AbortController().signal);
    expect(text).toContain("emil");
    expect(text).toContain("System prompt / body:");
    expect(text).toContain(body);
    expect(text).toContain("[source: claude]");
  });

  test("empty query respects the same default result limit as non-empty search", async () => {
    const many: AgentProfile[] = Array.from({ length: 20 }, (_, i) => ({
      id: `agent-${String(i).padStart(2, "0")}`,
      description: `Profile ${i}`,
      systemPromptRole: `You are agent ${i}.`,
    }));
    const tool = createSearchAgentsTool(() => many);
    if (tool.kind !== "string") throw new Error("expected string tool");
    const text = await tool.handler({ query: "" }, new AbortController().signal);
    const headers = [...text.matchAll(/^### (agent-\d+)/gm)].map((m) => m[1]);
    expect(headers).toHaveLength(12);
    expect(headers[0]).toBe("agent-00");
    expect(headers[11]).toBe("agent-11");
    expect(text).not.toContain("### agent-12");
  });

  test("empty catalog + empty query returns loaded-none message", async () => {
    const tool = createSearchAgentsTool(() => []);
    if (tool.kind !== "string") throw new Error("expected string tool");
    const text = await tool.handler({ query: "   " }, new AbortController().signal);
    expect(text).toBe("No agent profiles are loaded.");
  });

  test("handler redacts secret-shaped content in returned profile body", async () => {
    // End-to-end through the tool handler (not only the posix middleware unit test).
    const secret = "sk-live-abc123xyz789012345678";
    const tool = createSearchAgentsTool(() => [
      {
        id: "leaky",
        description: "Leaks credentials in body",
        source: "claude",
        // Line-start env assignment + high-confidence sk- token both match the scrubber.
        systemPromptRole: `TOKEN=supersecretvalue\nUse key ${secret} for the API.`,
      },
    ]);
    if (tool.kind !== "string") throw new Error("expected string tool");
    const text = await tool.handler({ query: "leaky" }, new AbortController().signal);
    expect(text).toContain("### leaky");
    expect(text).toContain(CREDENTIAL_REDACTION);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("supersecretvalue");
    expect(text).not.toContain("sk-live-abc123");
  });
});
