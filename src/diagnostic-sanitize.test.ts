import { describe, expect, test } from "bun:test";

import {
  sanitizeDiagnosticText,
  sanitizeDiagnosticValue,
} from "./diagnostic-sanitize.js";

describe("diagnostic sanitization", () => {
  test("scrubs an opaque configured credential without dropping useful detail", () => {
    const secret = "opaque phrase with spaces / punctuation?!";
    const diagnostic =
      `provider rejected ${secret} while calling https://relay.example/v1 ` +
      "with status 401";

    const sanitized = sanitizeDiagnosticText(diagnostic, [secret]);

    expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("provider rejected");
    expect(sanitized).toContain("https://relay.example/v1");
    expect(sanitized).toContain("status 401");
  });

  test("recursively scrubs opaque credentials and terminal controls", () => {
    const secret = "not-token-shaped";
    const sanitized = sanitizeDiagnosticValue(
      {
        error: `reflected ${secret}\u001b[31m`,
        nested: [`still ${secret}`],
      },
      [secret],
    );

    expect(JSON.stringify(sanitized)).not.toContain(secret);
    expect(JSON.stringify(sanitized)).not.toContain("\\u001b");
    expect(sanitized).toEqual({
      error: "reflected [redacted: configured credential]",
      nested: ["still [redacted: configured credential]"],
    });
  });
});
