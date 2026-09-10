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

  test("binds concurrent servers to distinct loopback ports", async () => {
    const first = await startCallbackServer();
    const second = await startCallbackServer();
    try {
      const firstUrl = new URL(first.redirectUrl);
      const secondUrl = new URL(second.redirectUrl);

      expect(firstUrl.hostname).toBe("127.0.0.1");
      expect(secondUrl.hostname).toBe("127.0.0.1");
      expect(firstUrl.port).not.toBe(secondUrl.port);
      expect(Number(firstUrl.port)).toBeGreaterThan(0);
      expect(Number(secondUrl.port)).toBeGreaterThan(0);
    } finally {
      first.close();
      second.close();
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

  test("close is idempotent and does not leak a waiter after a late callback", async () => {
    const server = await startCallbackServer();
    authorize(server, "expected");
    server.close();
    server.close();

    await expect(
      fetch(`${server.redirectUrl}?code=abc&state=expected`).then(
        () => "fetched",
        (err: unknown) => err,
      ),
    ).resolves.toBeInstanceOf(Error);
    await expect(server.waitForCode(new AbortController().signal)).rejects.toThrow(
      "closed before authorization completed",
    );
  });

  test("rejects start when listen fails without rewriting the OS error as a retry", async () => {
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
              listeners.error?.(new Error("listen EACCES: permission denied"));
            },
            address: (): undefined => undefined,
          };
          return fake as unknown as Server;
        }) as typeof real.createServer,
      }),
      async () => {
        await expect(startCallbackServer()).rejects.toThrow(
          "Could not start the OAuth callback server: listen EACCES: permission denied",
        );
      },
    );
  });
});
