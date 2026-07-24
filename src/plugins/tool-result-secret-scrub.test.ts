import { describe, test, expect } from "bun:test";
import {
  CREDENTIAL_REDACTION,
  scrubSecretShapedToolResultContent,
} from "./tool-result-secret-scrub.js";
import { toolResultSecretScrubPlugin } from "./tool-result-secret-scrub-plugin.js";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

describe("scrubSecretShapedToolResultContent", () => {
  test("redacts grep-surfaced .env assignment", () => {
    const text = "./app/.env:3:API_KEY=sk-live-abc123xyz789012345678";
    const out = scrubSecretShapedToolResultContent(text);
    expect(out).toContain(`API_KEY=${CREDENTIAL_REDACTION}`);
    expect(out).not.toContain("sk-live-abc123");
  });

  test("redacts PEM block in shell output", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA7
-----END RSA PRIVATE KEY-----`;
    const text = `wrote key:\n${pem}\n`;
    const out = scrubSecretShapedToolResultContent(text);
    expect(out).toBe(`wrote key:\n${CREDENTIAL_REDACTION}\n`);
    expect(out).not.toContain("MIIEpAIBAAKCAQEA7");
  });

  test("passes benign documentation mentioning API keys", () => {
    const text =
      "See docs/authentication.md for how API keys are issued and rotated. No secrets in this paragraph.";
    expect(scrubSecretShapedToolResultContent(text)).toBe(text);
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

  test("scrubs secret-shaped content in search_agents results", async () => {
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