import { describe, expect, test } from "bun:test";
import type { Server } from "node:http";

import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import { startCallbackServer } from "./callback-server.js";

const authorize = (
  server: Awaited<ReturnType<typeof startCallbackServer>>,
  state: string,
): void => {
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
      await expect(server.waitForCode(new AbortController().signal)).rejects.toThrow(
        "access_denied",
      );

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

  test("binds an ephemeral OS-assigned port on 127.0.0.1", async () => {
    const server = await startCallbackServer();
    try {
      const url = new URL(server.redirectUrl);

      expect(url.hostname).toBe("127.0.0.1");
      expect(Number(url.port)).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  test("rejects a pending waitForCode when the server is closed", async () => {
    const server = await startCallbackServer();
    const pending = server.waitForCode(new AbortController().signal).then(
      () => "resolved",
      (err: Error) => err.message,
    );

    server.close();

    expect(await pending).toContain("closed before authorization completed");
    await expect(server.waitForCode(new AbortController().signal)).rejects.toThrow(
      "closed before authorization completed",
    );
  });

  test("reports a clear actionable error when the server fails to bind", async () => {
    await withMockedModuleDuring(
      import.meta.resolve("node:http"),
      (real: typeof import("node:http")) => ({
        ...real,
        createServer: (() => {
          const listeners: Partial<Record<string, (err: Error) => void>> = {};
          const fake = {
            once: (event: string, cb: (err: Error) => void) => {
              listeners[event] = cb;
              return fake;
            },
            listen: () => {
              listeners.error?.(new Error("listen EADDRINUSE: address already in use"));
            },
            address: (): undefined => undefined,
          };
          return fake as unknown as Server;
        }) as typeof real.createServer,
      }),
      async () => {
        const err: unknown = await startCallbackServer().then(
          () => undefined,
          (failure: unknown) => failure,
        );
        const error = err as Error;

        expect(error.message).toContain("OAuth callback server");
        expect(error.message).toContain("EADDRINUSE");
        expect(error.message).toContain("retry");
      },
    );
  });
});
