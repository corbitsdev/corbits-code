import { test, expect, describe, afterEach } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { productCallbackCopy } from "../../branding.js";
import { startCodexCallbackServer } from "./callback-server.js";
import { CODEX_CALLBACK_PORT, CODEX_CALLBACK_PATH } from "./constants.js";

// These tests bind the fixed Codex callback port (1455). Each closes its server
// in afterEach so the port is free for the next case.
let active: { close: () => void } | undefined;

afterEach(() => {
  active?.close();
  active = undefined;
});

const base = `http://127.0.0.1:${String(CODEX_CALLBACK_PORT)}${CODEX_CALLBACK_PATH}`;

// Resolve the wait into a discriminated result so the rejection handler is
// attached immediately (no unhandled rejection) and the test can assert on the
// settled outcome without coupling to fetch timing.
function settle(
  server: { waitForCode: (s: AbortSignal) => Promise<string> },
  signal: AbortSignal,
) {
  return server.waitForCode(signal).then(
    (code) => ({ ok: true as const, code }),
    (err: unknown) => ({
      ok: false as const,
      message: err instanceof Error ? err.message : String(err),
    }),
  );
}

describe("startCodexCallbackServer", () => {
  test("resolves with the code when state matches", async () => {
    const server = await startCodexCallbackServer(
      "good-state",
      productCallbackCopy,
    );
    active = server;
    expect(server.port).toBe(CODEX_CALLBACK_PORT);
    const result = settle(server, new AbortController().signal);
    await fetch(`${base}?code=the-code&state=good-state`).catch(
      () => undefined,
    );
    const r = await result;
    expect(r).toEqual({ ok: true, code: "the-code" });
  });

  test("keeps waiting when the state does not match", async () => {
    const server = await startCodexCallbackServer(
      "expected-state",
      productCallbackCopy,
    );
    active = server;
    const result = settle(server, new AbortController().signal);
    const mismatch = await fetch(`${base}?code=the-code&state=attacker-state`);
    expect(mismatch.status).toBe(400);
    expect(
      await Promise.race([
        result.then(() => "settled"),
        delay(50).then(() => "pending"),
      ]),
    ).toBe("pending");
    await fetch(`${base}?code=the-code&state=expected-state`).catch(
      () => undefined,
    );
    expect(await result).toEqual({ ok: true, code: "the-code" });
  });

  test("keeps waiting when the redirect carries no state at all", async () => {
    const server = await startCodexCallbackServer(
      "expected-state",
      productCallbackCopy,
    );
    active = server;
    const result = settle(server, new AbortController().signal);
    const missing = await fetch(`${base}?code=the-code`);
    expect(missing.status).toBe(400);
    expect(
      await Promise.race([
        result.then(() => "settled"),
        delay(50).then(() => "pending"),
      ]),
    ).toBe("pending");
    await fetch(`${base}?code=the-code&state=expected-state`).catch(
      () => undefined,
    );
    expect(await result).toEqual({ ok: true, code: "the-code" });
  });

  test("rejects when the authorization server returns an error", async () => {
    const server = await startCodexCallbackServer("s", productCallbackCopy);
    active = server;
    const result = settle(server, new AbortController().signal);
    await fetch(`${base}?error=access_denied&state=s`).catch(() => undefined);
    const r = await result;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/access_denied/);
  });

  test("aborts the wait when the signal fires", async () => {
    const server = await startCodexCallbackServer("s", productCallbackCopy);
    active = server;
    const controller = new AbortController();
    const result = settle(server, controller.signal);
    controller.abort();
    const r = await result;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/aborted/);
  });
});
