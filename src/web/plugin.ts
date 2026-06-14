import { type } from "arktype";
import type { ToolPlugin, ExtraTool } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import type { ProviderResolutionOptions } from "./providers/index.js";
import { getWebProvider, withRetry, resetWebProvider } from "./providers/index.js";
import { scrubSecrets } from "./secret-scrub.js";
import type { WebResult } from "./types.js";
import { isBlockedURL } from "./url-policy.js";

// Security note on run_shell network egress: secretGuardPlugin does not scan
// run_shell command strings for URL access. This means the agent can curl/wget
// arbitrary URLs today with none of the SSRF or secret-scrub guarantees that
// web_fetch provides. The web contract is the supervised, auditable,
// policy-enforced path; run_shell remains an unsupervised escape hatch.
// Solving shell sandboxing is out of scope for this issue.

export type WebToolsPluginOptions = ProviderResolutionOptions;

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
    "Fetch a web page and return its content as markdown. Requests text/markdown by default and falls back to HTML-to-markdown conversion. Use this to read documentation, blog posts, and external references.",
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

const WebResultSchema = type({ title: "string", url: "string", snippet: "string" });

function validateResults(raw: unknown[]): WebResult[] {
  const results: WebResult[] = [];
  for (const item of raw) {
    const parsed = WebResultSchema(item);
    if (!(parsed instanceof type.errors)) results.push(parsed);
  }
  return results;
}

export function webToolsPlugin(options: WebToolsPluginOptions = {}): ToolPlugin {
  // Reset the provider holder on each plugin creation so tests don't share
  // state across plugin instances.
  resetWebProvider();

  const searchTool: ExtraTool = {
    definition: WEB_SEARCH_DEFINITION,
    handler: async (call: ToolCall, signal: AbortSignal): Promise<ToolResult> => {
      const query = typeof call.arguments.query === "string" ? call.arguments.query : "";
      if (query.length === 0) {
        return makeErrorResult(call.id, "web_search requires a non-empty query");
      }

      const provider = getWebProvider(options);
      try {
        const results = await withRetry(
          () => provider.search(query, signal),
          "web_search",
        );
        const validated = validateResults(results);
        return makeSuccessResult(call.id, { results: validated });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return makeErrorResult(call.id, message);
      }
    },
  };

  const fetchTool: ExtraTool = {
    definition: WEB_FETCH_DEFINITION,
    handler: async (call: ToolCall, signal: AbortSignal): Promise<ToolResult> => {
      const url = typeof call.arguments.url === "string" ? call.arguments.url : "";
      if (url.length === 0) {
        return makeErrorResult(call.id, "web_fetch requires a non-empty url");
      }

      const policy = isBlockedURL(url);
      if (policy.blocked) {
        return makeErrorResult(call.id, `URL blocked by policy: ${policy.reason}`);
      }

      const provider = getWebProvider(options);
      try {
        const content = await withRetry(
          () => provider.fetch(url, signal),
          "web_fetch",
        );
        return makeSuccessResult(call.id, { content });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return makeErrorResult(call.id, message);
      }
    },
  };

  return {
    tools: [searchTool, fetchTool],
  };
}
