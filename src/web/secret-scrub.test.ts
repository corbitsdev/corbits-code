import { expect, test } from "bun:test";
import { scrubSecrets } from "./secret-scrub.js";

test("redacts api_key query param", () => {
  const text = "Request failed: https://api.example.com/?api_key=sk-abc123";
  expect(scrubSecrets(text)).toBe("Request failed: https://api.example.com/?api_key=[REDACTED]");
});

test("redacts token query param", () => {
  const text = "url?token=secret-token-123";
  expect(scrubSecrets(text)).toBe("url?token=[REDACTED]");
});

test("redacts Authorization Bearer header", () => {
  const text = "Headers: Authorization: Bearer sk-1234567890abcdef";
  expect(scrubSecrets(text)).toBe("Headers: Authorization: [REDACTED]");
});

test("redacts Authorization Basic header", () => {
  const text = "Authorization: Basic dXNlcjpwYXNz";
  expect(scrubSecrets(text)).toBe("Authorization: [REDACTED]");
});

test("redacts apiKey in JSON", () => {
  const text = '{"apiKey":"super-secret-key-123"}';
  expect(scrubSecrets(text)).toBe('{"apiKey":"[REDACTED]"}');
});

test("redacts api_key in JSON", () => {
  const text = '{"api_key":"super-secret-key-123"}';
  expect(scrubSecrets(text)).toBe('{"api_key":"[REDACTED]"}');
});

test("redacts key in JSON", () => {
  const text = '{"key":"my-key-value"}';
  expect(scrubSecrets(text)).toBe('{"key":"[REDACTED]"}');
});

test("leaves safe text unchanged", () => {
  const text = "Hello world, this is a normal message with no secrets.";
  expect(scrubSecrets(text)).toBe(text);
});

test("redacts hex key blob", () => {
  const text = "token=abcdef1234567890abcdef1234567890";
  expect(scrubSecrets(text)).toBe("token=[REDACTED]");
});
