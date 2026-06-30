import { type } from "arktype";
import type { ToolPlugin, ExtraTool } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { withRetry } from "./providers/index.js";
import { scrubSecrets } from "./secret-scrub.js";
import { WebResultValidator } from "./types.js";
import type { WebProvider, WebResult } from "./types.js";

// Web access is delegated entirely to plugins (and, where a model exposes one,
// its native web tool). There is no built-in fetcher: without a configured web
// plugin, web_search and web_fetch are simply not registered. This keeps SSRF
// and network-egress concerns inside the external provider's infrastructure
// rather than fetching arbitrary URLs from this process.

export type WebToolsPluginOptions = { provider?: WebProvider };

const WEB_SEARCH_DEFINITION = {
  name: "web_search",
  description:
    "Search the web for information. Returns a list of results with title, URL, and snippet. Use this to find documentation, examples, and external references.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query string",
      },
    },
    required: ["query"],
  },
};

const WEB_FETCH_DEFINITION = {
  name: "web_fetch",
  description:
    "Fetch a web page and return its content as markdown. Use this to read documentation, blog posts, and external references.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL to fetch (must be http or https)",
      },
    },
    required: ["url"],
  },
};

function makeErrorResult(callId: string, message: string): ToolResult {
  return { callId, content: `Error: ${scrubSecrets(message)}`, isError: true };
}

function makeSuccessResult(callId: string, content: Record<string, unknown>): ToolResult {
  return { callId, content };
}

function validateResults(raw: unknown[]): WebResult[] {
  const results: WebResult[] = [];
  for (const item of raw) {
    const parsed = WebResultValidator(item);
    if (!(parsed instanceof type.errors)) results.push(parsed);
  }
  return results;
}

export function webToolsPlugin(options: WebToolsPluginOptions = {}): ToolPlugin {
  const provider = options.provider;
  // Plugin-only: with no provider there is no web access, so register nothing.
  if (provider === undefined) return { tools: [] };

  const searchTool: ExtraTool = {
    definition: WEB_SEARCH_DEFINITION,
    handler: async (call: ToolCall, signal: AbortSignal): Promise<ToolResult> => {
      const query = type("string>0")(call.arguments.query);
      if (query instanceof type.errors) {
        return makeErrorResult(call.id, "web_search requires a non-empty query");
      }
      try {
        const results = await withRetry(() => provider.search(query, signal), "web_search");
        return makeSuccessResult(call.id, { results: validateResults(results) });
      } catch (err) {
        return makeErrorResult(call.id, err instanceof Error ? err.message : String(err));
      }
    },
  };

  const fetchTool: ExtraTool = {
    definition: WEB_FETCH_DEFINITION,
    handler: async (call: ToolCall, signal: AbortSignal): Promise<ToolResult> => {
      const url = type("string>0")(call.arguments.url);
      if (url instanceof type.errors) {
        return makeErrorResult(call.id, "web_fetch requires a non-empty url");
      }
      try {
        const content = await withRetry(() => provider.fetch(url, signal), "web_fetch");
        return makeSuccessResult(call.id, { content });
      } catch (err) {
        return makeErrorResult(call.id, err instanceof Error ? err.message : String(err));
      }
    },
  };

  return { tools: [searchTool, fetchTool] };
}
