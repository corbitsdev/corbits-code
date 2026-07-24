import { stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";
import type { AgentProfile } from "./profiles.js";

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function profileSearchText(profile: AgentProfile): string {
  const parts = [profile.id, profile.description ?? "", profile.systemPromptRole ?? ""];
  return parts.join(" ");
}

export type AgentIndex = {
  search(query: string, limit?: number): AgentProfile[];
};

// Lexical ranker over id, description, and role text — same spirit as tool_search.
export function createAgentIndex(getProfiles: () => readonly AgentProfile[]): AgentIndex {
  const score = (profile: AgentProfile, queryTokens: string[], rawQuery: string): number => {
    const idTokens = tokenize(profile.id);
    const blob = profileSearchText(profile).toLowerCase();
    const blobTokens = new Set(tokenize(blob));
    let total = 0;
    for (const token of queryTokens) {
      if (idTokens.includes(token)) total += 3;
      else if (blobTokens.has(token)) total += 1;
      else if (profile.id.toLowerCase().includes(token)) total += 0.75;
      else if (blob.includes(token)) total += 0.25;
    }
    if (profile.id.toLowerCase().includes(rawQuery)) total += 1;
    if ((profile.description ?? "").toLowerCase().includes(rawQuery)) total += 0.5;
    return total;
  };

  return {
    search(query: string, limit = 12): AgentProfile[] {
      const rawQuery = query.toLowerCase().trim();
      const queryTokens = tokenize(query);
      const profiles = getProfiles();
      if (queryTokens.length === 0) return profiles.slice(0, limit);
      return profiles
        .map((p) => ({ profile: p, score: score(p, queryTokens, rawQuery) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((entry) => entry.profile);
    },
  };
}

// Format one profile for search_agents output. Injects the full loaded
// systemPromptRole (markdown body / role text) so the parent can inspect plugin
// and marketplace agents without read_file on paths outside the session cwd
// (path-escape blocks those roots by design).
function formatAgentProfileEntry(p: AgentProfile): string {
  const desc = (p.description ?? "").trim();
  const tier = p.tier !== undefined ? ` [tier: ${p.tier}]` : "";
  const orch = p.orchestrator === true ? " [orchestrator]" : "";
  const source = p.source !== undefined ? ` [source: ${p.source}]` : "";
  const header =
    desc.length > 0
      ? `### ${p.id}${tier}${orch}${source}\n${desc}`
      : `### ${p.id}${tier}${orch}${source}`;
  const body = (p.systemPromptRole ?? "").trim();
  if (body.length === 0) return header;
  return `${header}\n\nSystem prompt / body:\n${body}`;
}

export function formatAgentSearchResults(profiles: readonly AgentProfile[]): string {
  if (profiles.length === 0) {
    return "No agent profiles matched. Try broader terms (e.g. review, explore, implement) or list_dir on .agents/agents/.";
  }
  const entries = profiles.map(formatAgentProfileEntry);
  return [
    "Matching agent profiles (pass id to task(agent=...)). Full system prompt / body is included so you do not need read_file on plugin roots outside the workspace:",
    "",
    ...entries.flatMap((entry, i) => (i === 0 ? [entry] : ["", entry])),
    "",
    "Spawn with task(description, prompt, agent=<id>). For a team, call task once per member (parallel in one turn when independent).",
  ].join("\n");
}

export const searchAgentsDefinition: ToolDefinition = {
  name: "search_agents",
  description:
    "Find task-dispatchable agent profiles by capability, role, or team name (e.g. 'review', 'review team', 'architect', 'security'). Returns profile ids, descriptions, and the full loaded system prompt / body for each match so you can inspect plugin or Claude marketplace agents without reading files outside the workspace. Use the id in task(agent=...). Call this when the user asks to spin up specialists or a team without naming exact ids.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What kind of agent or team you need — keywords from the user's request (e.g. 'review team', 'code quality', 'explore codebase').",
      },
    },
    required: ["query"],
  },
};

const SearchAgentsArgs = type({ query: "string" });

export function createSearchAgentsTool(getProfiles: () => readonly AgentProfile[]): AgentTool {
  const index = createAgentIndex(getProfiles);
  return stringTool({
    definition: searchAgentsDefinition,
    handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
      const parsed = SearchAgentsArgs(rawArgs);
      if (parsed instanceof type.errors) {
        return "Error: search_agents requires query (string).";
      }
      const query = parsed.query.trim();
      if (query.length === 0) {
        const all = getProfiles();
        if (all.length === 0) return "No agent profiles are loaded.";
        return formatAgentSearchResults(all);
      }
      return formatAgentSearchResults(index.search(query));
    },
  });
}