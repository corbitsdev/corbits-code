import { stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";
import { scrubSecretShapedToolResultContent } from "../plugins/tool-result-secret-scrub.js";
import type { AgentProfile } from "./profiles.js";

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function profileSearchText(profile: AgentProfile): string {
  const parts = [profile.id, profile.description ?? "", profile.systemPromptRole ?? ""];
  return parts.join(" ");
}

export interface AgentIndex {
  search(query: string, limit?: number): AgentProfile[];
}

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

// Hard cap per injected body so a single oversized marketplace profile cannot
// blow the tool-result budget even when result count is already limited.
export const MAX_AGENT_SEARCH_BODY_CHARS = 8_000;

function truncateAgentBody(body: string): string {
  if (body.length <= MAX_AGENT_SEARCH_BODY_CHARS) return body;
  return `${body.slice(0, MAX_AGENT_SEARCH_BODY_CHARS)}\n…[truncated]`;
}

// Format one profile for search_agents output. Injects the full loaded
// systemPromptRole (markdown body / role text) so the parent can inspect plugin
// and marketplace agents without read_file on paths outside the session cwd
// (path-escape blocks those roots by design). Bodies longer than
// MAX_AGENT_SEARCH_BODY_CHARS are truncated with an ellipsis marker.
function formatAgentProfileEntry(p: AgentProfile): string {
  const desc = (p.description ?? "").trim();
  const orch = p.orchestrator === true ? " [orchestrator]" : "";
  const source = p.source !== undefined ? ` [source: ${p.source}]` : "";
  const header =
    desc.length > 0 ? `### ${p.id}${orch}${source}\n${desc}` : `### ${p.id}${orch}${source}`;
  const body = (p.systemPromptRole ?? "").trim();
  if (body.length === 0) return header;
  return `${header}\n\nSystem prompt / body:\n${truncateAgentBody(body)}`;
}

export function formatAgentSearchResults(profiles: readonly AgentProfile[]): string {
  if (profiles.length === 0) {
    return "No agent profiles matched. Try broader terms (e.g. review, explore, implement) or list_dir on .agents/agents/.";
  }
  const entries = profiles.map(formatAgentProfileEntry);
  // Live scrub for search_agents: this tool is not on the posix middleware path, so
  // SCRUBBABLE_TOOLS in tool-result-secret-scrub-plugin cannot reach it. Scrub here
  // before the formatted string becomes a tool result (marketplace/plugin bodies may
  // contain secret-shaped substrings).
  return scrubSecretShapedToolResultContent(
    [
      "Matching agent profiles (pass id to spawn_agent(agent=...)). Full system prompt / body is included so you do not need read_file on plugin roots outside the workspace:",
      "",
      ...entries.flatMap((entry, i) => (i === 0 ? [entry] : ["", entry])),
      "",
      "Spawn with spawn_agent(description, prompt, agent=<id>). For a team, call spawn_agent once per member (parallel in one turn when independent), then collect with wait_agents.",
    ].join("\n"),
  );
}

export const searchAgentsDefinition: ToolDefinition = {
  name: "search_agents",
  description:
    "Find spawnable agent profiles by capability, role, or team name (e.g. 'review', 'review team', 'architect', 'security'). Returns profile ids, descriptions, and the full loaded system prompt / body for each match so you can inspect plugin or Claude marketplace agents without reading files outside the workspace. Use the id in spawn_agent(agent=...). Call this when the user asks to spin up specialists or a team without naming exact ids.",
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
      // Empty and non-empty queries share createAgentIndex.search's default limit
      // (12) so a large marketplace catalog cannot dump every body into one result.
      if (query.length === 0 && getProfiles().length === 0) {
        return "No agent profiles are loaded.";
      }
      return formatAgentSearchResults(index.search(query));
    },
  });
}
