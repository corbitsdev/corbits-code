import { describe, expect, test } from "bun:test";

import { XAI_CALLBACK_PORT } from "./constants.js";
import { startXaiCallbackServer } from "./callback-server.js";

const base = `http://127.0.0.1:${String(XAI_CALLBACK_PORT)}/callback`;

describe("xAI callback server", () => {
  test("accepts a matching state and returns the code", async () => {
    const server = await startXaiCallbackServer("expected");
    try {
      const wait = server.waitForCode(new AbortController().signal);
      const res = await fetch(`${base}?code=abc&state=expected`);
      expect(res.status).toBe(200);
      await expect(wait).resolves.toBe("abc");
    } finally {
      server.close();
    }
  });

  test("rejects state mismatches before accepting a code", async () => {
    const server = await startXaiCallbackServer("expected");
    try {
      const wait = server.waitForCode(new AbortController().signal).then(
        () => ({ ok: true as const }),
        (err: unknown) => ({ ok: false as const, err }),
      );
      const res = await fetch(`${base}?code=abc&state=wrong`);
      expect(res.status).toBe(400);
      const result = await wait;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.err).toBeInstanceOf(Error);
      if (!result.ok && result.err instanceof Error) expect(result.err.message).toMatch(/state did not match/);
    } finally {
      server.close();
    }
  });
});
