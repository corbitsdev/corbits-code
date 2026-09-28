import { describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";

import type { CallbackPageCopy } from "../callback-page.js";
import { XAI_CALLBACK_PATH, XAI_CALLBACK_PORT } from "./constants.js";
import { startXaiCallbackServer } from "./callback-server.js";

const copy: CallbackPageCopy = {
  productName: "Fixture Product",
  siteUrl: "https://fixture.example",
  siteLabel: "fixture.example",
  githubUrl: "https://github.com/fixture",
  githubLabel: "github.com/fixture",
};

const base = `http://127.0.0.1:${String(XAI_CALLBACK_PORT)}${XAI_CALLBACK_PATH}`;

describe("xAI callback server", () => {
  test("accepts a matching state and returns the code", async () => {
    const server = await startXaiCallbackServer("expected", copy);
    try {
      expect(server.port).toBe(XAI_CALLBACK_PORT);
      const wait = server.waitForCode(new AbortController().signal);
      const res = await fetch(`${base}?code=abc&state=expected`);
      expect(res.status).toBe(200);
      await expect(wait).resolves.toBe("abc");
    } finally {
      server.close();
    }
  });

  test("keeps waiting after a state mismatch until a matching redirect", async () => {
    const server = await startXaiCallbackServer("expected", copy);
    try {
      const wait = server.waitForCode(new AbortController().signal);
      const mismatch = await fetch(`${base}?code=abc&state=wrong`);
      expect(mismatch.status).toBe(400);
      expect(
        await Promise.race([
          wait.then(() => "settled"),
          delay(50).then(() => "pending"),
        ]),
      ).toBe("pending");
      const match = await fetch(`${base}?code=abc&state=expected`);
      expect(match.status).toBe(200);
      await expect(wait).resolves.toBe("abc");
    } finally {
      server.close();
    }
  });
});
