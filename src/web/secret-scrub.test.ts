import { expect, test } from "bun:test";
import { scrubSecrets } from "./secret-scrub.js";

test("redacts secrets in URLs, headers, and JSON", () => {
  const cases: [string, string][] = [
    [
      "Request failed: https://api.example.com/?api_key=sk-abc123",
      "Request failed: https://api.example.com/?api_key=[REDACTED]",
    ],
    ["url?token=secret-token-123", "url?token=[REDACTED]"],
    [
      "Headers: Authorization: Bearer sk-1234567890abcdef",
      "Headers: Authorization: [REDACTED]",
    ],
    ["Authorization: Basic dXNlcjpwYXNz", "Authorization: [REDACTED]"],
    ['{"apiKey":"super-secret-key-123"}', '{"apiKey":"[REDACTED]"}'],
    ['{"api_key":"super-secret-key-123"}', '{"api_key":"[REDACTED]"}'],
    ['{"key":"my-key-value"}', '{"key":"[REDACTED]"}'],
    ["token=abcdef1234567890abcdef1234567890", "token=[REDACTED]"],
  ];
  for (const [input, expected] of cases) {
    expect(scrubSecrets(input)).toBe(expected);
  }
});

test("leaves safe text unchanged", () => {
  const text = "Hello world, this is a normal message with no secrets.";
  expect(scrubSecrets(text)).toBe(text);
});
