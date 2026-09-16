import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@intx/types/runtime";

import { createAgentIndex } from "./agent-search.js";
import type { AgentProfile } from "./profiles.js";
import { createSkillSearchTool } from "./skill-search.js";
import type { SkillSummary } from "../extensions/skills.js";
import { createToolIndex } from "./tool-search.js";

/**
 * The three search surfaces share one lexical ranker and one rank-and-cut
 * pipeline; only per-surface scoring bonuses differ. This fixture drives all
 * three with parallel catalogs so a weight change in one copy fails loudly
 * instead of drifting silently.
 */
const QUERY = "granola";

const tools: ToolDefinition[] = [
  {
    name: "granola-notes",
    description: "unrelated helper",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "mygranolahoard",
    description: "unrelated helper",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "notebook",
    description: "granola syncing helper",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "calendar",
    description: "scheduling helper",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

const skills: SkillSummary[] = [
  { name: "granola-notes", description: "unrelated helper" },
  { name: "mygranolahoard", description: "unrelated helper" },
  { name: "notebook", description: "granola syncing helper" },
  { name: "calendar", description: "scheduling helper" },
];

const agents: AgentProfile[] = [
  { id: "granola-notes", description: "unrelated helper" },
  { id: "mygranolahoard", description: "unrelated helper" },
  { id: "notebook", description: "granola syncing helper" },
  { id: "calendar", description: "scheduling helper" },
];

async function skillOrder(query: string): Promise<string[]> {
  const tool = createSkillSearchTool({ skills });
  if (tool.kind !== "string") throw new Error("expected string tool");
  const out = await tool.handler({ query }, new AbortController().signal);
  return out
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).split(":")[0] ?? "");
}

describe("search scorer parity", () => {
  test("tool, skill, and agent search rank one catalog the same way", async () => {
    const expected = ["granola-notes", "mygranolahoard", "notebook"];
    const skillHits = await skillOrder(QUERY);
    const agentHits = createAgentIndex(() => agents)
      .search(QUERY)
      .map((profile) => profile.id);
    expect(skillHits).toEqual(expected);
    expect(agentHits).toEqual(expected);
    // tool_search uses the same ranker, then keeps only the peak cluster
    // so a specific query does not fill the N cap with weak cousins.
    const toolHits = createToolIndex(() => tools, []).search(QUERY);
    expect(toolHits[0]).toBe(expected[0]);
    expect(expected.slice(0, toolHits.length)).toEqual(toolHits);
    expect(toolHits.length).toBeGreaterThan(0);
    expect(toolHits.length).toBeLessThanOrEqual(expected.length);
  });
});
