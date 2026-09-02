import { describe, test, expect } from "bun:test";
import { CREDENTIAL_REDACTION, scrubSecretShapedContent } from "./tool-result-secret-scrub.js";
import { toolResultSecretScrubPlugin } from "./tool-result-secret-scrub-plugin.js";
import { resultTruncationPlugin } from "./result-truncation-plugin.js";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

describe("scrubSecretShapedContent", () => {
  test("redacts grep-surfaced .env assignment", () => {
    const text = "./app/.env:3:API_KEY=sk-live-abc123xyz789012345678";
    const out = scrubSecretShapedContent(text);
    expect(out).toContain(`API_KEY=${CREDENTIAL_REDACTION}`);
    expect(out).not.toContain("sk-live-abc123");
  });

  test("redacts PEM block in shell output", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA7
-----END RSA PRIVATE KEY-----`;
    const text = `wrote key:\n${pem}\n`;
    const out = scrubSecretShapedContent(text);
    expect(out).toBe(`wrote key:\n${CREDENTIAL_REDACTION}\n`);
    expect(out).not.toContain("MIIEpAIBAAKCAQEA7");
  });

  test("is idempotent for redacted query parameters", () => {
    const text = "GET https://provider.invalid/v1?api_key=plain-value&model=test";
    const once = scrubSecretShapedContent(text);

    expect(scrubSecretShapedContent(once)).toBe(once);
    expect(once).toBe(`GET https://provider.invalid/v1?api_key=${CREDENTIAL_REDACTION}&model=test`);
  });

  test("passes benign documentation mentioning API keys", () => {
    const text =
      "See docs/authentication.md for how API keys are issued and rotated. No secrets in this paragraph.";
    expect(scrubSecretShapedContent(text)).toBe(text);
  });
});

describe("toolResultSecretScrubPlugin", () => {
  const next =
    (content: string) =>
    async (call: ToolCall): Promise<ToolResult> => ({ callId: call.id, content });

  test("scrubs grep tool results", async () => {
    const plugin = toolResultSecretScrubPlugin();
    const handler = plugin.middleware!(next("secrets/.env:1:TOKEN=supersecretvalue"));
    const result = await handler(
      { id: "c1", name: "grep", arguments: { pattern: "TOKEN" } },
      new AbortController().signal,
    );
    expect(result.content).toContain(CREDENTIAL_REDACTION);
    expect(result.content).not.toContain("supersecretvalue");
  });

  test("preserves query redaction through the long-result middleware chain", async () => {
    const content =
      "GET https://provider.invalid/v1?api_key=plain-value&model=test\n" + "x".repeat(11_000);
    const scrub = toolResultSecretScrubPlugin();
    const truncate = resultTruncationPlugin();
    if (scrub.middleware === undefined || truncate.middleware === undefined) {
      throw new Error("expected middleware plugins");
    }
    const handler = truncate.middleware(scrub.middleware(next(content)));

    const result = await handler(
      { id: "c-long", name: "grep", arguments: { pattern: "api_key" } },
      new AbortController().signal,
    );

    if (typeof result.content !== "string") throw new Error("expected text tool result");
    expect(result.content).toContain(`api_key=${CREDENTIAL_REDACTION}&model=test`);
    expect(result.content.match(/\[redacted: looks like a credential\]/g)).toHaveLength(1);
  });

  // search_agents is listed in SCRUBBABLE_TOOLS for future unified scrubbing, but
  // it is not on the posix middleware path today. Live scrub is in
  // formatAgentSearchResults — see agent-search.test.ts. This case only documents
  // that the plugin would scrub if such a result ever reached it.
  test("would scrub search_agents-shaped content if it reached posix middleware", async () => {
    const plugin = toolResultSecretScrubPlugin();
    const body =
      "Matching agent profiles:\n\n### leaky\n\nSystem prompt / body:\n" +
      "Use API_KEY=sk-live-abc123xyz789012345678 when calling the provider.";
    const handler = plugin.middleware!(next(body));
    const result = await handler(
      { id: "c2", name: "search_agents", arguments: { query: "leaky" } },
      new AbortController().signal,
    );
    expect(result.content).toContain(CREDENTIAL_REDACTION);
    expect(result.content).not.toContain("sk-live-abc123");
    expect(result.content).toContain("### leaky");
  });
});
