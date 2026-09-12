import { stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";
import { scrubSecretShapedContent } from "../plugins/tool-result-secret-scrub.js";
import type { AgentProfile } from "./profiles.js";

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function profileSearchText(profile: AgentProfile): string {
  const parts = [
    profile.id,
    profile.description ?? "",
    profile.systemPromptRole ?? "",
  ];
  return parts.join(" ");
}

export interface AgentIndex {
  search(query: string, limit?: number): AgentProfile[];
}

// Lexical ranker over id, description, and role text — same spirit as tool_search.
export function createAgentIndex(
  getProfiles: () => readonly AgentProfile[],
): AgentIndex {
  const score = (
    profile: AgentProfile,
    queryTokens: string[],
    rawQuery: string,
  ): number => {
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
    if ((profile.description ?? "").toLowerCase().includes(rawQuery))
      total += 0.5;
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

// Format one profile for search_agents output. Default is id, description, and
// spawn metadata (orchestrator flag, source). The loaded systemPromptRole is
// omitted unless includeBody is true. Bodies longer than
// MAX_AGENT_SEARCH_BODY_CHARS are truncated with an ellipsis marker.
function formatAgentProfileEntry(
  p: AgentProfile,
  includeBody: boolean,
): string {
  const desc = (p.description ?? "").trim();
  const orch = p.orchestrator === true ? " [orchestrator]" : "";
  const source = p.source !== undefined ? ` [source: ${p.source}]` : "";
  const header =
    desc.length > 0
      ? `### ${p.id}${orch}${source}\n${desc}`
      : `### ${p.id}${orch}${source}`;
  if (!includeBody) return header;
  const body = (p.systemPromptRole ?? "").trim();
  if (body.length === 0) return header;
  return `${header}\n\nSystem prompt / body:\n${truncateAgentBody(body)}`;
}

export function formatAgentSearchResults(
  profiles: readonly AgentProfile[],
  includeBody: boolean,
): string {
  if (profiles.length === 0) {
    return "No agent profiles matched. Try broader terms (e.g. review, explore, implement) or list_dir on .agents/agents/.";
  }
  const entries = profiles.map((p) => formatAgentProfileEntry(p, includeBody));
  // Live scrub for search_agents: this tool is not on the posix middleware path, so
  // SCRUBBABLE_TOOLS in tool-result-secret-scrub-plugin cannot reach it. Scrub here
  // before the formatted string becomes a tool result (marketplace/plugin bodies may
  // contain secret-shaped substrings).
  return scrubSecretShapedContent(
    [
      "Matching agent profiles (pass id to spawn_agent(agent=...)):",
      "",
      ...entries.flatMap((entry, i) => (i === 0 ? [entry] : ["", entry])),
      "",
      "Spawn with spawn_agent(description, prompt, agent=<id>). For a team, call spawn_agent once per member (parallel in one turn when independent), then reply and idle — mailbox mail arrives as inbound. wait_agents is mounted on exec-primary runs only.",
    ].join("\n"),
  );
}

export const searchAgentsDefinition: ToolDefinition = {
  name: "search_agents",
  description:
    "Find spawnable agent profiles by capability, role, or team name (e.g. 'review', 'review team', 'architect', 'security'). Returns profile ids, descriptions, and spawn metadata (orchestrator flag, source). Pass include_body=true to include the loaded system prompt / body for each match (truncated). Use the id in spawn_agent(agent=...). Call this when the user asks to spin up specialists or a team without naming exact ids.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What kind of agent or team you need — keywords from the user's request (e.g. 'review team', 'code quality', 'explore codebase').",
      },
      include_body: {
        type: "boolean",
        description:
          "When true, include each match's loaded system prompt / body (truncated). Default false: id, description, and spawn metadata only.",
      },
    },
    required: ["query"],
  },
};

const SearchAgentsArgs = type({ query: "string", "include_body?": "boolean" });

export function createSearchAgentsTool(
  getProfiles: () => readonly AgentProfile[],
): AgentTool {
  const index = createAgentIndex(getProfiles);
  return stringTool({
    definition: searchAgentsDefinition,
    handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
      const parsed = SearchAgentsArgs(rawArgs);
      if (parsed instanceof type.errors) {
        return "Error: search_agents requires query (string); include_body is optional boolean.";
      }
      const query = parsed.query.trim();
      const includeBody = parsed.include_body === true;
      // Empty and non-empty queries share createAgentIndex.search's default limit
      // (12) so a large marketplace catalog cannot dump every body into one result.
      if (query.length === 0 && getProfiles().length === 0) {
        return "No agent profiles are loaded.";
      }
      return formatAgentSearchResults(index.search(query), includeBody);
    },
  });
}
