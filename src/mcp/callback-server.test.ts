import { describe, expect, test } from "bun:test";

import { startCallbackServer } from "./callback-server.js";

describe("MCP callback server", () => {
  test("returns a code received before authorization begins waiting", async () => {
    const server = await startCallbackServer();
    try {
      const response = await fetch(`${server.redirectUrl}?code=abc`);

      expect(response.status).toBe(200);
      await expect(server.waitForCode(new AbortController().signal)).resolves.toBe("abc");
    } finally {
      server.close();
    }
  });

  test("preserves the first callback result", async () => {
    const server = await startCallbackServer();
    try {
      await fetch(`${server.redirectUrl}?code=abc`);
      const duplicateResponse = await fetch(`${server.redirectUrl}?error=access_denied`);

      expect(duplicateResponse.status).toBe(409);
      await expect(server.waitForCode(new AbortController().signal)).resolves.toBe("abc");
    } finally {
      server.close();
    }
  });
});
