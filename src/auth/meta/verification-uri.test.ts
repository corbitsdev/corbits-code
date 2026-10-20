import { describe, expect, test } from "bun:test";

import { isPinnedMetaVerificationUri } from "./verification-uri.js";

describe("isPinnedMetaVerificationUri", () => {
  test("accepts https on Meta's auth host", () => {
    expect(
      isPinnedMetaVerificationUri(
        "https://auth.meta.com/device?code=ABCD-1234",
      ),
    ).toBe(true);
  });

  test("rejects http and non-Meta hosts", () => {
    expect(
      isPinnedMetaVerificationUri("http://auth.meta.com/device?code=ABCD"),
    ).toBe(false);
    expect(
      isPinnedMetaVerificationUri("https://evil.example/device?code=ABCD"),
    ).toBe(false);
    expect(
      isPinnedMetaVerificationUri("https://auth.meta.com.evil.example/device"),
    ).toBe(false);
    expect(isPinnedMetaVerificationUri("not a url")).toBe(false);
  });
});
