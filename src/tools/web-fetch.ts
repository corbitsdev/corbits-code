import { type } from "arktype";
import { stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolCall, ToolDefinition, ToolResult } from "@intx/types/runtime";

import { checkUrlForSsrf } from "./ssrf-guard.js";
import { htmlToMarkdown, htmlToText } from "./html-convert.js";
import { COMMAND_NAME } from "../branding.js";
import type { MCPClient } from "../mcp/client.js";
import pkg from "../../package.json" with { type: "json" };

export const MAX_FETCH_BYTES = 5 * 1024 * 1024; // 5 MB
export const DEFAULT_TIMEOUT_S = 30;
export const MAX_TIMEOUT_S = 120;
export const MAX_REDIRECTS = 5;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function honestUserAgent(): string {
  return `${COMMAND_NAME}/${(pkg as { version: string }).version}`;
}

const WebFetchArgs = type({
  url: "string>0",
  "format?": "'text' | 'markdown' | 'html'",
  "timeout?": "number",
});

export const webFetchDefinition: ToolDefinition = {
  name: "web_fetch",
  description:
    "Fetch a web page over HTTP(S) and return its content. Uses built-in Exa MCP by default, or a direct in-process fetch when that built-in is disabled or overridden. Converts HTML to markdown by default. Use for documentation, articles, and other external references.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch (http or https only)" },
      format: {
        type: "string",
        enum: ["text", "markdown", "html"],
        description: "Output format. Defaults to markdown.",
      },
      timeout: {
        type: "number",
        description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}).`,
      },
    },
    required: ["url"],
  },
};

function acceptHeaderFor(format: "text" | "markdown" | "html"): string {
  if (format === "html") return "text/html,application/xhtml+xml";
  return "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5";
}

// Bot-detection blocks commonly answer with one of these; retrying once with an
// honest UA is the plan's documented escape hatch for sites that specifically
// reject an unfamiliar browser UA string but allow declared bots/tools.
function looksLikeBotBlock(status: number): boolean {
  return status === 403 || status === 429 || status === 999;
}

async function readCapped(
  response: Response,
  capBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (body === null) return { text: await response.text(), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    const remaining = capBytes - total;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    const slice = value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(slice);
    total += slice.byteLength;
    if (slice.byteLength < value.byteLength) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(buffer), truncated };
}

async function fetchOnce(
  url: string,
  userAgent: string,
  format: "text" | "markdown" | "html",
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": userAgent,
        Accept: acceptHeaderFor(format),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export type WebFetchOutcome =
  { ok: true; content: string; truncated: boolean } | { ok: false; error: string };

export async function runWebFetch(
  rawUrl: string,
  format: "text" | "markdown" | "html",
  timeoutSeconds: number,
): Promise<WebFetchOutcome> {
  const timeoutMs = Math.min(Math.max(timeoutSeconds, 1), MAX_TIMEOUT_S) * 1000;

  let currentUrl = rawUrl;
  let userAgent = BROWSER_USER_AGENT;
  let retriedWithHonestUA = false;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ssrf = await checkUrlForSsrf(currentUrl);
    if (!ssrf.ok) return { ok: false, error: ssrf.reason };

    let response: Response;
    try {
      response = await fetchOnce(currentUrl, userAgent, format, timeoutMs);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return {
          ok: false,
          error: `Request to ${currentUrl} timed out after ${timeoutMs / 1000}s. Retry with a larger timeout parameter (up to 120s) if the site is slow.`,
        };
      }
      return {
        ok: false,
        error: `Failed to fetch ${currentUrl}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) {
        return { ok: false, error: `Redirect from ${currentUrl} had no Location header.` };
      }
      const nextUrl = new URL(location, currentUrl).toString();
      await response.body?.cancel().catch(() => undefined);
      currentUrl = nextUrl;
      continue; // re-check SSRF on the new hop at the top of the loop
    }

    if (looksLikeBotBlock(response.status) && !retriedWithHonestUA) {
      await response.body?.cancel().catch(() => undefined);
      retriedWithHonestUA = true;
      userAgent = honestUserAgent();
      continue; // same URL, honest UA
    }

    if (!response.ok) {
      const { text } = await readCapped(response, 8192);
      return {
        ok: false,
        error: `Fetch of ${currentUrl} failed with status ${response.status}: ${text.slice(0, 500)}`,
      };
    }

    const { text: body, truncated } = await readCapped(response, MAX_FETCH_BYTES);
    const contentType = response.headers.get("content-type") ?? "";
    const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(body);

    let content: string;
    if (format === "html") {
      content = body;
    } else if (isHtml) {
      content = format === "markdown" ? htmlToMarkdown(body) : htmlToText(body);
    } else {
      content = body;
    }
    return { ok: true, content, truncated };
  }

  return { ok: false, error: `Too many redirects fetching ${rawUrl} (max ${MAX_REDIRECTS}).` };
}

export function createWebFetchTool(): AgentTool {
  return stringTool({
    definition: webFetchDefinition,
    handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
      const parsed = WebFetchArgs(rawArgs);
      if (parsed instanceof type.errors) {
        return "Error: web_fetch requires a non-empty url (http/https); format and timeout are optional.";
      }
      const format = parsed.format ?? "markdown";
      const timeout = parsed.timeout ?? DEFAULT_TIMEOUT_S;
      const outcome = await runWebFetch(parsed.url, format, timeout);
      if (!outcome.ok) return `Error: ${outcome.error}`;
      const suffix = outcome.truncated ? `\n\n[content truncated at ${MAX_FETCH_BYTES} bytes]` : "";
      return outcome.content + suffix;
    },
  });
}

type ExaMCPWebFetchConnection = { ok: true; client: MCPClient } | { ok: false; error: string };

export function createExaMCPWebFetchTool(args: {
  connect: (signal: AbortSignal) => Promise<ExaMCPWebFetchConnection>;
}): AgentTool {
  return {
    kind: "full",
    definition: webFetchDefinition,
    handler: async (call: ToolCall, signal: AbortSignal): Promise<ToolResult> => {
      const parsed = WebFetchArgs(call.arguments);
      if (parsed instanceof type.errors) {
        return {
          callId: call.id,
          content:
            "Error: web_fetch requires a non-empty url (http/https); format and timeout are optional.",
          isError: true,
        };
      }
      const connection = await args.connect(signal);
      if (!connection.ok) {
        return {
          callId: call.id,
          content: `Error: Exa MCP web_fetch unavailable: ${connection.error}`,
          isError: true,
        };
      }
      if (!connection.client.tools.some((tool) => tool.name === "web_fetch_exa")) {
        return {
          callId: call.id,
          content:
            "Error: Exa MCP web_fetch unavailable: connected Exa server did not advertise web_fetch_exa.",
          isError: true,
        };
      }
      try {
        const content = await connection.client.call(
          "web_fetch_exa",
          { urls: [parsed.url] },
          signal,
        );
        return { callId: call.id, content };
      } catch (err) {
        return {
          callId: call.id,
          content: `Error: Exa MCP web_fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}
