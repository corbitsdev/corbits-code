import { type } from "arktype";
import { htmlToMarkdown } from "../../../src/web/markdown.js";
import { scrubSecrets } from "../../../src/web/secret-scrub.js";
import { attemptLlmsTxt, truncateContent } from "../../../src/web/smart-fetch.js";

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
const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
const EXA_FETCH_TIMEOUT_MS = 30_000;
const CONTENTS_MAX_CHARS = 10_000;

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
  "highlights?": "string[]",
});

const ExaContentsResultSchema = type({
  "id?": "string",
  "url?": "string",
  "title?": "string",
  "text?": "string",
});

const ExaContentsResponseSchema = type({
  results: "unknown[]",
});

function bestSnippet(parsed: { text?: string; highlights?: string[] }): string {
  if (parsed.highlights !== undefined && parsed.highlights.length > 0) {
    return parsed.highlights.join(" … ");
  }
  return parsed.text ?? "";
}

function exaResultToWebResult(raw: unknown): WebResult | null {
  const parsed = ExaResultSchema(raw);
  if (parsed instanceof type.errors) return null;
  return {
    title: parsed.title,
    url: parsed.url,
    snippet: bestSnippet(parsed),
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

  const exaHeaders = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    Accept: "application/json",
  };

  return {
    name: "exa",

    async search(query: string, signal: AbortSignal): Promise<WebResult[]> {
      const response = await fetchImpl(EXA_SEARCH_URL, {
        method: "POST",
        signal: AbortSignal.any([signal, AbortSignal.timeout(EXA_FETCH_TIMEOUT_MS)]),
        headers: exaHeaders,
        body: JSON.stringify({
          query,
          numResults: 10,
          contents: {
            highlights: { numSentences: 3, highlightsPerUrl: 3 },
          },
        }),
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
      // Prefer llms.txt at the target origin before fetching the full page.
      const llmsTxt = await attemptLlmsTxt(url, fetchImpl, signal);
      if (llmsTxt !== null) return llmsTxt;

      // Use Exa's Contents API to get a cleaned, structured version of the page.
      try {
        const response = await fetchImpl(EXA_CONTENTS_URL, {
          method: "POST",
          signal: AbortSignal.any([signal, AbortSignal.timeout(EXA_FETCH_TIMEOUT_MS)]),
          headers: exaHeaders,
          body: JSON.stringify({
            ids: [url],
            text: { maxCharacters: CONTENTS_MAX_CHARS },
          }),
        });

        if (response.ok) {
          const raw: unknown = await response.json();
          const parsed = ExaContentsResponseSchema(raw);
          if (!(parsed instanceof type.errors) && parsed.results.length > 0) {
            const first = ExaContentsResultSchema(parsed.results[0]);
            if (!(first instanceof type.errors) && first.text !== undefined && first.text.length > 0) {
              return scrubSecrets(truncateContent(first.text));
            }
          }
        }
      } catch {
        // Fall through to plain HTTP fetch below.
      }

      // Plain HTTP fetch as final fallback.
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
        return scrubSecrets(truncateContent(body));
      }

      return scrubSecrets(truncateContent(htmlToMarkdown(body)));
    },
  };
}

export { createWebProvider };
