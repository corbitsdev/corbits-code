// Result-side secret scrubbing for web tool outputs. Provider error paths
// (401/403 bodies, echoed headers, query params) may leak API keys into
// ToolResult.content/detail, which are JSON.stringify'd into .agent-state/run.json
// in plaintext. This scrubber redacts known patterns before the result leaves
// the tool layer.

// Patterns that indicate a secret value in text.
const SECRET_PATTERNS: RegExp[] = [
  // URL query params for common API keys.
  /api_?key=[a-zA-Z0-9_\-]+/gi,
  /token=[a-zA-Z0-9_\-]+/gi,
  /secret=[a-zA-Z0-9_\-]+/gi,
  // Authorization header Bearer tokens.
  /Authorization:\s*Bearer\s+[a-zA-Z0-9_\-.]+/gi,
  // Basic auth credentials.
  /Authorization:\s*Basic\s+[a-zA-Z0-9+/=]+/gi,
  // Exa, Tavily, Firecrawl key-like values in error bodies.
  /"apiKey"\s*:\s*"[^"]*"/gi,
  /"api_key"\s*:\s*"[^"]*"/gi,
  /"key"\s*:\s*"[^"]*"/gi,
  // Generic hex key blobs.
  /[a-f0-9]{32,}/gi,
];

function redactPattern(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => {
    // URL query param: key=value
    const eq = match.indexOf("=");
    if (eq !== -1) return match.slice(0, eq + 1) + "[REDACTED]";

    // JSON: "key":"value" — check before the colon branch so JSON colons
    // are not treated as header separators.
    const quotes: number[] = [];
    let pos = 0;
    while (true) {
      const idx = match.indexOf('"', pos);
      if (idx === -1) break;
      quotes.push(idx);
      pos = idx + 1;
    }

    // "key":"value" has at least 4 quotes (open/close for key, open/close for value).
    if (quotes.length >= 4) {
      const valueOpen = quotes[2]!;
      const valueClose = quotes[quotes.length - 1]!;
      return match.slice(0, valueOpen + 1) + "[REDACTED]" + match.slice(valueClose);
    }

    // Header: Authorization: ...
    const colon = match.indexOf(":");
    if (colon !== -1) return match.slice(0, colon + 1) + " [REDACTED]";

    return "[REDACTED]";
  });
}

export function scrubSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = redactPattern(result, pattern);
  }
  return result;
}
