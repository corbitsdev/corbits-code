import { type } from "arktype";
import { stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

import { connectMCPServer, type MCPClient } from "../mcp/client.js";
import type { MCPServerConfig } from "../config/settings.js";
import { EXA_MCP_URL } from "../mcp/exa.js";

export { EXA_MCP_URL } from "../mcp/exa.js";

// Endpoint truth resolved from OpenCode's source (packages/opencode/src/tool/mcp-websearch.ts)
// at implementation time: both are public, keyless-by-default hosted MCP servers.
export const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";

export type WebSearchProviderId = "exa" | "parallel";

const WebSearchArgs = type({
  query: "string>0",
  "numResults?": "number",
  "type?": "'auto' | 'fast' | 'deep'",
  "livecrawl?": "'fallback' | 'preferred'",
  "contextMaxCharacters?": "number",
});

export const webSearchDefinition: ToolDefinition = {
  name: "web_search",
  description:
    "Search the web. Backed by a keyless hosted MCP provider (Exa by default) — no local API key required unless a provider override with credentials is configured. Returns ranked results as text.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      numResults: { type: "number", description: "Maximum number of results (default 8)." },
      type: {
        type: "string",
        enum: ["auto", "fast", "deep"],
        description: "Search depth/strategy. Defaults to auto.",
      },
      livecrawl: {
        type: "string",
        enum: ["fallback", "preferred"],
        description: "Whether to prefer or only fall back to a live crawl. Defaults to fallback.",
      },
      contextMaxCharacters: {
        type: "number",
        description: "Cap on returned context length in characters (default 10000).",
      },
    },
    required: ["query"],
  },
};

// Provider selection is env-driven (settings.env now makes this configuration
// rather than a shell export): CORBITS_WEB_SEARCH_PROVIDER selects "exa"
// (default) or "parallel"; CORBITS_WEB_SEARCH_API_KEY supplies an optional
// bearer key appended as a query param, matching both hosted MCP servers'
// documented keyless-with-optional-key auth model.
export function resolveWebSearchProvider(
  env: NodeJS.ProcessEnv = process.env,
): WebSearchProviderId {
  const raw = env.CORBITS_WEB_SEARCH_PROVIDER?.toLowerCase();
  return raw === "parallel" ? "parallel" : "exa";
}

function endpointFor(provider: WebSearchProviderId, env: NodeJS.ProcessEnv = process.env): string {
  const base = provider === "parallel" ? PARALLEL_MCP_URL : EXA_MCP_URL;
  const apiKey = env.CORBITS_WEB_SEARCH_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) return base;
  const url = new URL(base);
  url.searchParams.set("apiKey", apiKey);
  return url.toString();
}

// One connection per provider, established lazily on first search and reused
// across calls; torn down via disposeWebSearchClients() when the toolset is
// disposed.
const clientCache = new Map<WebSearchProviderId, Promise<MCPClient>>();

async function getClient(provider: WebSearchProviderId): Promise<MCPClient> {
  const cached = clientCache.get(provider);
  if (cached !== undefined) return cached;
  const config: MCPServerConfig = {
    name: `web-search-${provider}`,
    type: "http",
    url: endpointFor(provider),
  };
  const connecting = connectMCPServer(config).then((result) => {
    if (!result.ok) {
      clientCache.delete(provider);
      throw new Error(result.error);
    }
    return result.client;
  });
  clientCache.set(provider, connecting);
  return connecting;
}

export async function disposeWebSearchClients(): Promise<void> {
  const pending = [...clientCache.values()];
  clientCache.clear();
  await Promise.all(
    pending.map(async (p) => {
      try {
        const client = await p;
        await client.close();
      } catch {
        // Connection never succeeded or already closed; nothing to clean up.
      }
    }),
  );
}

function exaArgs(args: typeof WebSearchArgs.infer): Record<string, unknown> {
  return {
    query: args.query,
    numResults: args.numResults ?? 8,
    type: args.type ?? "auto",
    livecrawl: args.livecrawl ?? "fallback",
    contextMaxCharacters: args.contextMaxCharacters ?? 10000,
  };
}

// Parallel's hosted search tool takes an "objective" plus explicit search
// queries rather than Exa's flatter shape; approximate our common parameter
// set onto it (best-effort — Parallel is the optional, non-default provider).
function parallelArgs(args: typeof WebSearchArgs.infer): Record<string, unknown> {
  return {
    objective: args.query,
    search_queries: [args.query],
  };
}

function toolNameFor(provider: WebSearchProviderId): string {
  return provider === "parallel" ? "web_search" : "web_search_exa";
}

export function createWebSearchTool(): AgentTool {
  return stringTool({
    definition: webSearchDefinition,
    handler: async (rawArgs: Record<string, unknown>, signal: AbortSignal): Promise<string> => {
      const parsed = WebSearchArgs(rawArgs);
      if (parsed instanceof type.errors) {
        return "Error: web_search requires a non-empty query.";
      }
      const provider = resolveWebSearchProvider();
      try {
        const client = await getClient(provider);
        const args = provider === "parallel" ? parallelArgs(parsed) : exaArgs(parsed);
        const result = await client.call(toolNameFor(provider), args, signal);
        return result.length > 0 ? result : "No results.";
      } catch (err) {
        return `Error: web_search (${provider}) failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
