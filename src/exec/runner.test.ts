import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DIRECTOR_REGISTRY } from "../agent/directors/registry.js";
import {
  CodexAuthError,
  codexAuthFailureDiagnostic,
  CodexRefreshLockError,
} from "../auth/codex/session.js";
import type { Config } from "../config/index.js";
import { CREDENTIAL_FAILURE_USER_MESSAGE } from "../inference-error-message.js";
import { createAdvertisedToolset } from "../session/assemble-runtime.js";
import {
  armExecMcpHandshakeAbort,
  awaitExecMcpConnect,
  awaitExecMcpThenResume,
  followExecMcpHandshake,
} from "./mcp-handshake.js";
import {
  createExecToolCallGate,
  createExecToolPromoter,
  execUserFailureMessage,
  isExecOverlayToolAllowed,
  refreshSelectedProviderCredential,
  resolveExecDirectorOverlay,
  resolveExecDirectorOverlayForPackage,
} from "./runner.js";

const OUTSIDE_ALLOW = "mcp__linear__create_issue";

describe("exec director allowlist", () => {
  test("explorer overlay narrows advertised tools to the package allow list", () => {
    const overlay = resolveExecDirectorOverlay("explorer");
    expect(overlay.advertisedAllow).toBeDefined();
    expect(overlay.advertisedAllow).toContain("read_file");
    expect(overlay.advertisedAllow).toContain("run_shell");
    expect(overlay.advertisedAllow).not.toContain("tool_search");
    expect(overlay.advertisedAllow).not.toContain(OUTSIDE_ALLOW);
  });

  test("critic overlay narrows advertised tools to the package allow list", () => {
    const overlay = resolveExecDirectorOverlay("critic");
    expect(overlay.advertisedAllow).toBeDefined();
    expect(overlay.advertisedAllow).not.toContain("tool_search");
    expect(overlay.advertisedAllow).not.toContain(OUTSIDE_ALLOW);
  });

  test("skywalker keeps the product default — no allow list", () => {
    const overlay = resolveExecDirectorOverlay("skywalker");
    expect(overlay.advertisedAllow).toBeUndefined();
    expect(overlay.mountFleet).toBe(true);
  });

  test("deny entries are subtracted from the allow list", () => {
    const pkg = {
      ...DIRECTOR_REGISTRY.explorer,
      tools: { allow: ["read_file", "run_shell"], deny: ["run_shell"] },
    };
    expect(resolveExecDirectorOverlayForPackage(pkg).advertisedAllow).toEqual([
      "read_file",
    ]);
  });

  test("an allow that deny empties is rejected loudly", () => {
    const pkg = {
      ...DIRECTOR_REGISTRY.explorer,
      tools: { allow: ["run_shell"], deny: ["run_shell"] },
    };
    expect(() => resolveExecDirectorOverlayForPackage(pkg)).toThrow(/empty/);
  });

  test("a deny-only package config is rejected loudly", () => {
    const pkg = {
      ...DIRECTOR_REGISTRY.explorer,
      tools: { deny: ["run_shell"] },
    };
    expect(() => resolveExecDirectorOverlayForPackage(pkg)).toThrow(/deny/);
  });

  test("promote cannot make an outside-allow tool callable under explorer", () => {
    const overlay = resolveExecDirectorOverlay("explorer");
    expect(isExecOverlayToolAllowed(overlay, OUTSIDE_ALLOW)).toBe(false);
    const { activated, isAdvertised } = createAdvertisedToolset({
      sessionMode: "orchestrator",
      toolAvailability: { languageServerAvailable: true },
      getProvider: () => ({ providerName: "test", model: "test-model" }),
      builtInPrefix: overlay.advertisedAllow,
    });
    const promote = createExecToolPromoter({
      activate: (names) => activated.activate(names),
      isAllowed: (name) => isExecOverlayToolAllowed(overlay, name),
    });
    promote([OUTSIDE_ALLOW]);
    expect(activated.has(OUTSIDE_ALLOW)).toBe(false);
    expect(isAdvertised(OUTSIDE_ALLOW)).toBe(false);
    expect(createExecToolCallGate(isAdvertised)(OUTSIDE_ALLOW)).toBe(false);
  });

  test("the promoter commits allowed names onto the next infer wire", () => {
    const overlay = resolveExecDirectorOverlay("explorer");
    const { activated, computeAdvertised, flushPromotions } =
      createAdvertisedToolset({
        sessionMode: "orchestrator",
        toolAvailability: { languageServerAvailable: true },
        getProvider: () => ({ providerName: "test", model: "test-model" }),
        builtInPrefix: overlay.advertisedAllow,
      });
    let committed = 0;
    const promote = createExecToolPromoter({
      activate: (names) => activated.activate(names),
      isAllowed: (name) => isExecOverlayToolAllowed(overlay, name),
      commitWire: () => {
        if (flushPromotions()) committed += 1;
      },
    });
    const registry = [
      {
        name: "read_file",
        description: "read a file",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    promote([OUTSIDE_ALLOW, "read_file"]);
    expect(activated.has(OUTSIDE_ALLOW)).toBe(false);
    expect(activated.has("read_file")).toBe(true);
    expect(committed).toBe(1);
    expect(computeAdvertised(registry).map((d) => d.name)).toContain("read");
  });

  test("the promoter does not commit a name outside the overlay allow list", () => {
    const overlay = resolveExecDirectorOverlay("explorer");
    const { activated, computeAdvertised, flushPromotions } =
      createAdvertisedToolset({
        sessionMode: "orchestrator",
        toolAvailability: { languageServerAvailable: true },
        getProvider: () => ({ providerName: "test", model: "test-model" }),
        builtInPrefix: overlay.advertisedAllow,
      });
    let committed = 0;
    const promote = createExecToolPromoter({
      activate: (names) => activated.activate(names),
      isAllowed: (name) => isExecOverlayToolAllowed(overlay, name),
      commitWire: () => {
        if (flushPromotions()) committed += 1;
      },
    });
    const registry = [
      {
        name: OUTSIDE_ALLOW,
        description: "create an issue",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "lsp",
        description: "language server",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    promote([OUTSIDE_ALLOW]);
    expect(activated.has(OUTSIDE_ALLOW)).toBe(false);
    expect(committed).toBe(0);
    expect(computeAdvertised(registry).map((d) => d.name)).not.toContain(
      OUTSIDE_ALLOW,
    );
  });

  test("the promoter still commits lsp when the overlay allows it", () => {
    const overlay = resolveExecDirectorOverlay("explorer");
    expect(isExecOverlayToolAllowed(overlay, "lsp")).toBe(true);
    const { activated, computeAdvertised, flushPromotions } =
      createAdvertisedToolset({
        sessionMode: "orchestrator",
        toolAvailability: { languageServerAvailable: true },
        getProvider: () => ({ providerName: "test", model: "test-model" }),
        builtInPrefix: overlay.advertisedAllow,
      });
    let committed = 0;
    const promote = createExecToolPromoter({
      activate: (names) => activated.activate(names),
      isAllowed: (name) => isExecOverlayToolAllowed(overlay, name),
      commitWire: () => {
        if (flushPromotions()) committed += 1;
      },
    });
    const registry = [
      {
        name: "lsp",
        description: "language server",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: OUTSIDE_ALLOW,
        description: "create an issue",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    promote([OUTSIDE_ALLOW, "lsp"]);
    expect(activated.has(OUTSIDE_ALLOW)).toBe(false);
    expect(activated.has("lsp")).toBe(true);
    expect(committed).toBe(1);
    const names = computeAdvertised(registry).map((d) => d.name);
    expect(names).toContain("lsp");
    expect(names).not.toContain(OUTSIDE_ALLOW);
  });

  test("exec wires commitWire on the overlay-filtered promoter and onToolsActivate uses it", () => {
    const source = readFileSync(
      new URL("./runner.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("commitWire: commitPromotedWire");
    expect(source).toMatch(
      /createExecToolPromoter\(\{[\s\S]*?isAllowed:\s*\(name\)\s*=>\s*isExecOverlayToolAllowed\(overlay,\s*name\)[\s\S]*?commitWire:\s*commitPromotedWire/,
    );
    expect(source).toMatch(
      /onToolsActivate:\s*\(names\)\s*=>\s*promoteAndCommitWire\(names\)/,
    );
    expect(source).toContain("setToolPromoter(promoteAndCommitWire");
  });

  test("skywalker overlay leaves every tool allowed", () => {
    const overlay = resolveExecDirectorOverlay("skywalker");
    expect(isExecOverlayToolAllowed(overlay, OUTSIDE_ALLOW)).toBe(true);
  });
});

describe("exec MCP connect bounds", () => {
  test("a hung handshake wait returns timeout without waiting for connect", async () => {
    const connecting = new Promise<void>(() => {
      // Never settles: hung MCP handshake.
    });
    const started = Date.now();
    const outcome = await awaitExecMcpConnect(connecting, 30);
    expect(outcome).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(250);
  });

  test("a settled handshake returns before the wait bound", async () => {
    const outcome = await awaitExecMcpConnect(Promise.resolve(), 1_000);
    expect(outcome).toBe("settled");
  });

  test("handshake abort fires while connect is still in flight", async () => {
    const handshake = armExecMcpHandshakeAbort(30);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(handshake.signal.aborted).toBe(true);
  });

  test("disarming after a successful handshake does not abort the live connection", async () => {
    const handshake = armExecMcpHandshakeAbort(30);
    handshake.disarm();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(handshake.signal.aborted).toBe(false);
  });

  test("a rejected batch leaves the abort timer armed while siblings stay in flight", async () => {
    const handshake = armExecMcpHandshakeAbort(40);
    const connecting = followExecMcpHandshake(
      Promise.reject(new Error("onStatus threw")),
      handshake,
    ).catch(() => undefined);
    await connecting;
    expect(handshake.signal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(handshake.signal.aborted).toBe(true);
  });

  test("a fulfilled batch disarms so the abort cannot tear down the live connection", async () => {
    const handshake = armExecMcpHandshakeAbort(40);
    await followExecMcpHandshake(Promise.resolve(), handshake);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(handshake.signal.aborted).toBe(false);
  });

  test("resume waits for connect to settle even after the short wait times out", async () => {
    const handshake = armExecMcpHandshakeAbort(500);
    const events: string[] = [];
    const connecting = new Promise<void>((resolve) => {
      setTimeout(() => {
        events.push("settled");
        resolve();
      }, 50);
    });
    await awaitExecMcpThenResume(
      connecting.then(() => handshake.disarm()),
      async () => {
        events.push("resume");
      },
      { waitMs: 10, abort: handshake.signal },
    );
    expect(events).toEqual(["settled", "resume"]);
    handshake.disarm();
  });

  test("resume after a logged connect failure does not disarm the abort timer", async () => {
    const handshake = armExecMcpHandshakeAbort(40);
    let resumed = false;
    const connecting = followExecMcpHandshake(
      Promise.reject(new Error("filterServersForConnect failed")),
      handshake,
    ).catch(() => undefined);
    await awaitExecMcpThenResume(
      connecting,
      async () => {
        resumed = true;
      },
      { waitMs: 10, abort: handshake.signal },
    );
    expect(resumed).toBe(true);
    expect(handshake.signal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(handshake.signal.aborted).toBe(true);
  });

  test("a hung connect resumes when the abort fires instead of waiting forever", async () => {
    const handshake = armExecMcpHandshakeAbort(40);
    const connecting = followExecMcpHandshake(
      new Promise<void>(() => {
        // Never settles: hung sibling handshake that ignores the signal.
      }),
      handshake,
    ).catch(() => undefined);
    const started = Date.now();
    let resumed = false;
    await awaitExecMcpThenResume(
      connecting,
      async () => {
        resumed = true;
      },
      { waitMs: 10, abort: handshake.signal },
    );
    expect(resumed).toBe(true);
    expect(handshake.signal.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(250);
  });
});

describe("exec credential failure surface", () => {
  test("a raw codex refresh failure maps to the credential failure message", () => {
    const cfg = { inference: { timeoutMs: 1_000 } } as unknown as Config;
    const auth = new CodexAuthError(
      "personal",
      "refresh-failed",
      'Codex profile "personal" could not be refreshed (boom). Log in again.',
    );
    // Raw auth error, no SELECTED wrapper and no provider failure observed:
    // still a credential failure, never the bare provider text.
    expect(execUserFailureMessage(cfg, auth, false)).toBe(
      CREDENTIAL_FAILURE_USER_MESSAGE,
    );
  });

  test("a missing codex profile maps to the credential failure message", () => {
    const cfg = { inference: { timeoutMs: 1_000 } } as unknown as Config;
    const auth = new CodexAuthError(
      "ghost",
      "missing",
      'Codex profile "ghost" is missing. Log in again to recreate it.',
    );
    expect(execUserFailureMessage(cfg, auth, false)).toBe(
      CREDENTIAL_FAILURE_USER_MESSAGE,
    );
  });

  test("the credential failure message itself carries the re-login hint", () => {
    expect(CREDENTIAL_FAILURE_USER_MESSAGE).toMatch(/log in again/i);
  });

  test("a codex refresh lock failure keeps its own message with the lock path", async () => {
    const cfg = { inference: { timeoutMs: 1_000 } } as unknown as Config;
    const lockPath = "/tmp/cl8628-codex-auth.refresh.lock";
    const lock = new CodexRefreshLockError(
      "personal",
      lockPath,
      `Timed out after 30000ms waiting for the Codex refresh lock at ${lockPath}.`,
    );
    // Joint surface with the combined classifier (#1138 rework is in flight
    // in parallel): the lock error never composes into credential_failure.
    expect(codexAuthFailureDiagnostic(lock)).toBeNull();
    // Raw pre-send failure: the exec layer repeats the lock message verbatim
    // instead of the generic re-login hint.
    const raw = execUserFailureMessage(cfg, lock, false);
    expect(raw).toContain(lockPath);
    expect(raw).not.toBe(CREDENTIAL_FAILURE_USER_MESSAGE);
    expect(raw).not.toMatch(/log in again/i);
    // First-inference refresh wraps failures in SELECTED_PROVIDER_FAILURE:
    // the lock path must survive that wrapper too.
    const wrapped = await refreshSelectedProviderCredential(() =>
      Promise.reject(lock),
    ).then(
      () => {
        throw new Error("expected the refresh to fail");
      },
      (err: unknown) => err,
    );
    const throughWrapper = execUserFailureMessage(cfg, wrapped, false);
    expect(throughWrapper).toContain(lockPath);
    expect(throughWrapper).not.toBe(CREDENTIAL_FAILURE_USER_MESSAGE);
  });
});
