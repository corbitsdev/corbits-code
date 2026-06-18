import { type } from "arktype";
import { htmlToMarkdown } from "../../../src/web/markdown.js";
import { scrubSecrets } from "../../../src/web/secret-scrub.js";

// Minimal WebProvider shape, structurally compatible with the core
// src/web/types.ts WebProvider/WebResult interfaces. Kept self-contained so the
// plugin does not depend on core internals; the core loader validates that the
// returned object has { name, search, fetch }.
export type WebResult = {
  title: string;
  url: string;
  snippet: string;
  extra?: Record<string, unknown>;
};

export interface WebProvider {
  readonly name: string;
  search(query: string, signal: AbortSignal): Promise<WebResult[]>;
  fetch(url: string, signal: AbortSignal): Promise<string>;
}

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const EXA_FETCH_TIMEOUT_MS = 30_000;

// Self-description consumed by the plugin loader and the /plugins UI: the kind
// wires this in as the web backend, and the credential field tells the UI to
// collect an Exa API key before the provider can run.
export const manifest = {
  id: "exa",
  name: "Exa Search",
  kind: "web" as const,
  description: "Web search and page fetch powered by the Exa API.",
  credentials: [
    {
      key: "apiKey",
      label: "Exa API Key",
      description: "Create one at dashboard.exa.ai (starts with a UUID).",
      secret: true,
    },
  ],
};

const ExaProviderOptionsSchema = type({
  apiKey: "string>0",
  // Allow tests to inject a fetch implementation; not user-configurable.
  "fetchImpl?": "unknown",
});

const ExaSearchResponseSchema = type({
  results: "unknown[]",
  "autopromoted?": "unknown[]",
  "cost_cents?": "number",
  "resolved_search_type?": "string",
});

const ExaResultSchema = type({
  title: "string",
  url: "string",
  "publishedDate?": "string",
  "author?": "string",
  "score?": "number",
  "id?": "string",
  "text?": "string",
});

function exaResultToWebResult(raw: unknown): WebResult | null {
  const parsed = ExaResultSchema(raw);
  if (parsed instanceof type.errors) return null;
  return {
    title: parsed.title,
    url: parsed.url,
    snippet: parsed.text ?? "",
    extra: {
      ...(parsed.publishedDate !== undefined ? { publishedDate: parsed.publishedDate } : {}),
      ...(parsed.author !== undefined ? { author: parsed.author } : {}),
      ...(parsed.score !== undefined ? { score: parsed.score } : {}),
    },
  };
}

export default function createWebProvider(options: unknown): WebProvider {
  const parsed = ExaProviderOptionsSchema(options);
  if (parsed instanceof type.errors) {
    throw new Error(`Exa web provider requires { apiKey: string }: ${parsed.summary}`);
  }

  const apiKey = parsed.apiKey;
  const fetchImpl = (parsed.fetchImpl as typeof fetch | undefined) ?? fetch;

  return {
    name: "exa",

    async search(query: string, signal: AbortSignal): Promise<WebResult[]> {
      const response = await fetchImpl(EXA_SEARCH_URL, {
        method: "POST",
        signal: AbortSignal.any([signal, AbortSignal.timeout(EXA_FETCH_TIMEOUT_MS)]),
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          Accept: "application/json",
        },
        body: JSON.stringify({ query, numResults: 10, contents: { text: true } }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Exa search returned ${response.status}${body.length > 0 ? `: ${body.slice(0, 500)}` : ""}`,
        );
      }

      const raw: unknown = await response.json();
      const parsedResponse = ExaSearchResponseSchema(raw);
      if (parsedResponse instanceof type.errors) {
        throw new Error("Exa search returned an unrecognizable response shape");
      }

      const results: WebResult[] = [];
      for (const item of parsedResponse.results) {
        const mapped = exaResultToWebResult(item);
        if (mapped !== null) results.push(mapped);
      }
      return results;
    },

    async fetch(url: string, signal: AbortSignal): Promise<string> {
      // Exa exposes no generic fetch-arbitrary-URL endpoint, so forward as a
      // plain HTTP fetch (matching the core local provider's fallback).
      //
      // The core web_fetch tool runs the initial URL through isBlockedURL before
      // calling this, but redirects are not re-checked here (the SSRF policy lives
      // in core and should not be duplicated into every provider). TODO: core
      // should hand providers a policy-checked fetch so redirect hops are gated
      // the way the local provider gates them. Tracked as a follow-up.
      const response = await fetchImpl(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(EXA_FETCH_TIMEOUT_MS)]),
        headers: {
          Accept: "text/markdown; q=1.0, text/html; q=0.9, text/plain; q=0.8, */*; q=0.7",
          "User-Agent": "Mozilla/5.0 (compatible; Intercode/1.0)",
        },
      });

      if (!response.ok) {
        throw new Error(scrubSecrets(`fetch returned ${response.status} for ${url}`));
      }

      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();

      if (contentType.includes("text/markdown") || contentType.includes("text/plain")) {
        return scrubSecrets(body);
      }

      return scrubSecrets(htmlToMarkdown(body));
    },
  };
}

export { createWebProvider };
