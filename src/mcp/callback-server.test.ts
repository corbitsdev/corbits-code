import { describe, expect, test } from "bun:test";

import { startCallbackServer } from "./callback-server.js";

const authorize = (server: Awaited<ReturnType<typeof startCallbackServer>>, state: string): void => {
  server.expectState(state);
};

describe("MCP callback server", () => {
  test("returns a matching code received before authorization begins waiting", async () => {
    const server = await startCallbackServer();
    try {
      authorize(server, "expected");
      const response = await fetch(`${server.redirectUrl}?code=abc&state=expected`);

      expect(response.status).toBe(200);
      await expect(server.waitForCode(new AbortController().signal)).resolves.toBe("abc");
    } finally {
      server.close();
    }
  });

  test("rejects callback state mismatches without consuming authorization", async () => {
    const server = await startCallbackServer();
    try {
      authorize(server, "expected");
      const rejected = await fetch(`${server.redirectUrl}?code=wrong&state=unexpected`);
      const accepted = await fetch(`${server.redirectUrl}?code=abc&state=expected`);

      expect(rejected.status).toBe(400);
      expect(accepted.status).toBe(200);
      await expect(server.waitForCode(new AbortController().signal)).resolves.toBe("abc");
    } finally {
      server.close();
    }
  });

  test("allows reauthorization after an early callback error", async () => {
    const server = await startCallbackServer();
    try {
      authorize(server, "first");
      await fetch(`${server.redirectUrl}?error=access_denied&state=first`);
      await expect(server.waitForCode(new AbortController().signal)).rejects.toThrow("access_denied");

      authorize(server, "second");
      const response = await fetch(`${server.redirectUrl}?code=abc&state=second`);

      expect(response.status).toBe(200);
      await expect(server.waitForCode(new AbortController().signal)).resolves.toBe("abc");
    } finally {
      server.close();
    }
  });

  test("rejects an aborted authorization even when a callback is pending", async () => {
    const server = await startCallbackServer();
    try {
      authorize(server, "expected");
      await fetch(`${server.redirectUrl}?code=abc&state=expected`);
      const controller = new AbortController();
      controller.abort();

      await expect(server.waitForCode(controller.signal)).rejects.toThrow("aborted");
    } finally {
      server.close();
    }
  });
});
