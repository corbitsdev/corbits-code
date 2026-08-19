import { test, expect, describe, afterEach } from "bun:test";
import { startCodexCallbackServer } from "../../src/adapters/auth/codex/callback-server.js";
import { CODEX_CALLBACK_PORT, CODEX_CALLBACK_PATH } from "../../src/adapters/auth/codex/constants.js";

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
function settle(server: { waitForCode: (s: AbortSignal) => Promise<string> }, signal: AbortSignal) {
  return server.waitForCode(signal).then(
    (code) => ({ ok: true as const, code }),
    (err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) }),
  );
}

describe("startCodexCallbackServer", () => {
  test("resolves with the code when state matches", async () => {
    const server = await startCodexCallbackServer("good-state");
    active = server;
    const result = settle(server, new AbortController().signal);
    await fetch(`${base}?code=the-code&state=good-state`).catch(() => undefined);
    const r = await result;
    expect(r).toEqual({ ok: true, code: "the-code" });
  });

  test("rejects when the state does not match (CSRF guard)", async () => {
    const server = await startCodexCallbackServer("expected-state");
    active = server;
    const result = settle(server, new AbortController().signal);
    await fetch(`${base}?code=the-code&state=attacker-state`).catch(() => undefined);
    const r = await result;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/state did not match/i);
  });

  test("rejects when the redirect carries no state at all", async () => {
    const server = await startCodexCallbackServer("expected-state");
    active = server;
    const result = settle(server, new AbortController().signal);
    await fetch(`${base}?code=the-code`).catch(() => undefined);
    const r = await result;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/state did not match/i);
  });

  test("rejects when the authorization server returns an error", async () => {
    const server = await startCodexCallbackServer("s");
    active = server;
    const result = settle(server, new AbortController().signal);
    await fetch(`${base}?error=access_denied&state=s`).catch(() => undefined);
    const r = await result;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/access_denied/);
  });

  test("aborts the wait when the signal fires", async () => {
    const server = await startCodexCallbackServer("s");
    active = server;
    const controller = new AbortController();
    const result = settle(server, controller.signal);
    controller.abort();
    const r = await result;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/aborted/);
  });
});
