import { describe, expect, test } from "bun:test";
import { OAuthTokenEndpointError } from "@corbits/oauth-core";
import {
  isOAuthTokenEndpointError,
  sanitizedRefreshFailure,
} from "./token-session-boundary.js";

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

describe("isOAuthTokenEndpointError", () => {
  test("accepts the host class and a foreign copy with the same name", () => {
    const local = new OAuthTokenEndpointError(401, "denied");
    expect(isOAuthTokenEndpointError(local)).toBe(true);

    const foreign = Object.assign(
      new Error("OAuth token endpoint returned 401"),
      {
        name: "OAuthTokenEndpointError",
        status: 401,
        detail: "denied",
      },
    );
    expect(foreign).not.toBeInstanceOf(OAuthTokenEndpointError);
    expect(isOAuthTokenEndpointError(foreign)).toBe(true);
  });

  test("rejects errors that only share a message", () => {
    expect(
      isOAuthTokenEndpointError(new Error("OAuth token endpoint returned 401")),
    ).toBe(false);
  });
});
