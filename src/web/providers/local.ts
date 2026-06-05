import { isBlockedURL } from "../url-policy.js";
import { htmlToMarkdown } from "../markdown.js";
import { scrubSecrets } from "../secret-scrub.js";
import type { WebProvider, WebResult } from "../types.js";

const SEARCH_URL = "https://lite.duckduckgo.com/lite/";
const FETCH_TIMEOUT_MS = 30_000;

const ACCEPT_HEADER = "text/markdown; q=1.0, text/html; q=0.9, text/plain; q=0.8, */*; q=0.7";

export type LocalProviderOptions = {
  fetchImpl?: typeof fetch;
};

function createFetchError(message: string, cause?: unknown): Error {
  const err = new Error(message);
  if (cause !== undefined) {
    (err as { cause?: unknown }).cause = cause;
  }
  return err;
}

export function createLocalProvider(options: LocalProviderOptions = {}): WebProvider {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: "local",

    async search(query: string, signal: AbortSignal): Promise<WebResult[]> {
      const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}`;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: {
            Accept: "text/html",
            "User-Agent": "Mozilla/5.0 (compatible; Intercode/1.0)",
          },
        });
      } catch (err) {
        throw createFetchError(`search request failed: ${err instanceof Error ? err.message : String(err)}`, err);
      }

      if (!response.ok) {
        throw createFetchError(`search returned ${response.status}`);
      }

      const html = await response.text();
      const results = parseDuckDuckGoResults(html);
      // If parsing yields nothing, return empty — the HTML structure may have
      // changed. This is a soft failure, not an error.
      return results;
    },

    async fetch(url: string, signal: AbortSignal): Promise<string> {
      const policy = isBlockedURL(url);
      if (policy.blocked) {
        throw createFetchError(`fetch blocked by policy: ${policy.reason}`);
      }

      let response: Response;
      try {
        response = await fetchImpl(url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: {
            Accept: ACCEPT_HEADER,
            "User-Agent": "Mozilla/5.0 (compatible; Intercode/1.0)",
          },
        });
      } catch (err) {
        throw createFetchError(`fetch request failed: ${err instanceof Error ? err.message : String(err)}`, err);
      }

      if (!response.ok) {
        const scrubbed = scrubSecrets(`fetch returned ${response.status} for ${url}`);
        throw createFetchError(scrubbed);
      }

      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();

      if (contentType.includes("text/markdown")) {
        return scrubSecrets(body);
      }

      if (contentType.includes("text/plain")) {
        return scrubSecrets(body);
      }

      // Default: treat as HTML (even if Content-Type is missing or unexpected).
      return scrubSecrets(htmlToMarkdown(body));
    },
  };
}

// Best-effort parser for DuckDuckGo Lite result pages. Uses simple regexes
// rather than a full HTML parser. If the page structure changes, parsing may
// yield zero results — callers should treat that as empty, not error.
function parseDuckDuckGoResults(html: string): WebResult[] {
  const results: WebResult[] = [];

  // DuckDuckGo Lite wraps each result in a <tr> with a result link.
  // Link: <a class="result-link" href="..."></a> or similar.
  // Snippet: nearby text after the link.
  // We look for <a> tags with an href and a nearby title.
  const linkRegex = /<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const seenUrls = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1]?.trim() ?? "";
    const rawLabel = match[2] ?? "";
    const label = stripTags(rawLabel).trim();

    if (!href || href.startsWith("/") || seenUrls.has(href)) continue;
    if (label.length === 0) continue;

    // Try to find a snippet in the text after this link.
    const after = html.slice(match.index + match[0].length, match.index + match[0].length + 800);
    const snippet = extractSnippet(after);

    seenUrls.add(href);
    results.push({ title: label, url: href, snippet });

    if (results.length >= 10) break;
  }

  return results;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();
}

function extractSnippet(afterHtml: string): string {
  // Look for the next chunk of plain text before another major tag.
  const text = stripTags(afterHtml);
  // Truncate to a reasonable snippet length.
  const truncated = text.slice(0, 300);
  const lastPeriod = truncated.lastIndexOf(".");
  if (lastPeriod > 50) {
    return truncated.slice(0, lastPeriod + 1);
  }
  return truncated;
}
