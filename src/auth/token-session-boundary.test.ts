import { describe, expect, test } from "bun:test";
import { OAuthTokenEndpointError } from "@corbits/oauth-core";
import { sanitizedRefreshFailure } from "./token-session-boundary.js";

describe("sanitizedRefreshFailure", () => {
  test("scrubs already-materialized stacks recursively without losing classification", () => {
    const refresh = "opaque refresh credential / reflected?!";
    const endpoint = new OAuthTokenEndpointError(
      401,
      `grant rejected for ${refresh}`,
    );
    const failure = new Error(`refresh failed for ${refresh}`, {
      cause: endpoint,
    });
    expect(failure.stack).toContain(refresh);
    expect(endpoint.stack).toContain(refresh);

    const sanitized = sanitizedRefreshFailure(failure, refresh);

    expect(sanitized).toBe(failure);
    expect(sanitized.message).not.toContain(refresh);
    expect(sanitized.stack).not.toContain(refresh);
    expect(sanitized.cause).toBe(endpoint);
    expect(endpoint).toBeInstanceOf(OAuthTokenEndpointError);
    expect(endpoint.status).toBe(401);
    expect(endpoint.message).not.toContain(refresh);
    expect(endpoint.detail).not.toContain(refresh);
    expect(endpoint.stack).not.toContain(refresh);
  });
});
