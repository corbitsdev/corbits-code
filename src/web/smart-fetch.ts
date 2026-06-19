// llms.txt discovery and content normalization for web_fetch.
//
// The llms.txt convention (llmstxt.org) provides machine-readable summaries
// of a site's documentation. When present they are far more signal-dense than
// raw page content and cost far fewer model tokens. We try several candidate
// paths before falling back to the full page.

import { htmlToMarkdown } from "./markdown.js";
import { scrubSecrets } from "./secret-scrub.js";

const MAX_CONTENT_CHARS = 15_000;
const LLMS_TXT_TIMEOUT_MS = 10_000;

function apexOrigin(url: URL): string | null {
  const parts = url.hostname.split(".");
  if (parts.length <= 2) return null;
  return `${url.protocol}//${parts.slice(-2).join(".")}`;
}

// Returns candidate llms.txt URLs to probe for a given page URL.
// Priority: same-origin, apex-domain root, apex-domain /docs.
function llmsTxtCandidates(rawUrl: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return [];
  }
  const origin = parsed.origin;
  const apex = apexOrigin(parsed);
  const candidates: string[] = [`${origin}/llms.txt`];
  if (apex !== null && apex !== origin) {
    candidates.push(`${apex}/llms.txt`, `${apex}/docs/llms.txt`);
  } else {
    candidates.push(`${origin}/docs/llms.txt`);
  }
  return candidates;
}

async function tryGet(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(LLMS_TXT_TIMEOUT_MS)]),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Intercode/1.0)" },
    });
    if (!res.ok) return null;
    // llms.txt files are always plain text. Reject HTML responses so that
    // servers returning a generic 200 page for every path do not match.
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/html")) return null;
    const text = await res.text();
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

export function truncateContent(content: string): string {
  if (content.length <= MAX_CONTENT_CHARS) return content;
  const remaining = content.length - MAX_CONTENT_CHARS;
  return `${content.slice(0, MAX_CONTENT_CHARS)}\n\n[... ${remaining} more characters truncated]`;
}

// Try llms.txt candidates derived from the given URL. Returns the first
// successful response, or null if none of the candidates respond with 2xx.
// Uses fetchImpl directly (no SSRF wrapper needed — candidates share the
// same origin as the already-validated request URL).
export async function attemptLlmsTxt(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<string | null> {
  for (const candidate of llmsTxtCandidates(url)) {
    const text = await tryGet(fetchImpl, candidate, signal);
    if (text !== null) {
      return scrubSecrets(truncateContent(text));
    }
  }
  return null;
}

// Normalise a raw HTTP response body to clean text.
// Converts HTML via htmlToMarkdown; returns markdown and plain text as-is.
// Truncates to MAX_CONTENT_CHARS regardless of source format.
export function normalizeBody(contentType: string, body: string): string {
  const content =
    contentType.includes("text/markdown") || contentType.includes("text/plain")
      ? body
      : htmlToMarkdown(body);
  return scrubSecrets(truncateContent(content));
}
