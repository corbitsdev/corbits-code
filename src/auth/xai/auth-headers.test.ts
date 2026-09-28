import { describe, expect, test } from "bun:test";

import { xaiAuthHeadersForToken } from "./auth-headers.js";

function accessTokenWithSub(sub: string): string {
  const segment = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  return `${segment({ alg: "none" })}.${segment({ sub })}.sig`;
}

describe("xaiAuthHeadersForToken", () => {
  test("lifts a clean JWT sub into x-grok-user-id", () => {
    const headers = xaiAuthHeadersForToken({
      access: accessTokenWithSub("user-123"),
    });
    expect(headers["x-grok-user-id"]).toBe("user-123");
    expect(headers.authorization).toBe(
      `Bearer ${accessTokenWithSub("user-123")}`,
    );
  });

  test("omits x-grok-user-id when the JWT sub carries CR, LF, or NUL", () => {
    for (const sub of ["user\r123", "user\n123", "user\u0000123"]) {
      const headers = xaiAuthHeadersForToken({
        access: accessTokenWithSub(sub),
      });
      expect("x-grok-user-id" in headers).toBe(false);
    }
  });
});
