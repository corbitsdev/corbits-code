import { describe, expect, test } from "bun:test";

import {
  redactedCorrelationId,
  scrubCorrelationShapedIds,
} from "./redacted-correlation.js";

describe("redactedCorrelationId", () => {
  test("never exposes the full ID", () => {
    const id = "6f4f7c16-2e21-4a2d-9f4b-7c1e93a88b41";
    const redacted = redactedCorrelationId(id);
    expect(redacted).not.toBe(id);
    expect(redacted.length).toBeLessThan(id.length);
    expect(redacted).not.toContain(id.slice(8));
    expect(redacted).toStartWith(id.slice(0, 8));
    expect(redacted).toContain("#");
  });

  test("is stable for the same id and distinct across ids", () => {
    expect(redactedCorrelationId("corr-a")).toBe(
      redactedCorrelationId("corr-a"),
    );
    expect(redactedCorrelationId("corr-a")).not.toBe(
      redactedCorrelationId("corr-b"),
    );
  });

  test("ids whose prefixes collide remain distinct through the hash suffix", () => {
    const a = "12345678-1111-4a2d-9f4b-7c1e93a88b41";
    const b = "12345678-2222-4a2d-9f4b-7c1e93a88b41";
    expect(a.slice(0, 8)).toBe(b.slice(0, 8));
    expect(redactedCorrelationId(a)).not.toBe(redactedCorrelationId(b));
  });
});

describe("scrubCorrelationShapedIds", () => {
  test("redacts every UUID-shaped id to its standard redacted form", () => {
    const a = "6f4f7c16-2e21-4a2d-9f4b-7c1e93a88b41";
    const b = "5a5dfc8e-90cd-4f6a-b6d3-4e8a1a2b3c4d";
    const out = scrubCorrelationShapedIds(`drop ${a} then ${b}`);
    expect(out).toBe(
      `drop ${redactedCorrelationId(a)} then ${redactedCorrelationId(b)}`,
    );
  });

  test("leaves prose and non-correlation tokens intact", () => {
    const text = "store read failed for path ~/.corbits/settings.json: EIO";
    expect(scrubCorrelationShapedIds(text)).toBe(text);
  });
});
