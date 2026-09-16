import { describe, expect, test } from "bun:test";
import { DIRECTOR_REGISTRY } from "../agent/directors/registry.js";
import { createAdvertisedToolset } from "../session/assemble-runtime.js";
import {
  armExecMcpHandshakeAbort,
  awaitExecMcpConnect,
  createExecToolCallGate,
  createExecToolPromoter,
  isExecOverlayToolAllowed,
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
    expect(
      createExecToolCallGate(isAdvertised, { isCodex: false })(OUTSIDE_ALLOW),
    ).toBe(false);
  });

  test("the promoter gates allow itself and leaves the wire set for the fold", () => {
    const overlay = resolveExecDirectorOverlay("explorer");
    const { activated, computeAdvertised, flushPromotions } =
      createAdvertisedToolset({
        sessionMode: "orchestrator",
        toolAvailability: { languageServerAvailable: true },
        getProvider: () => ({ providerName: "test", model: "test-model" }),
        builtInPrefix: overlay.advertisedAllow,
      });
    const promote = createExecToolPromoter({
      activate: (names) => activated.activate(names),
      isAllowed: (name) => isExecOverlayToolAllowed(overlay, name),
    });
    const registry = [
      {
        name: "read_file",
        description: "read a file",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    const before = JSON.stringify(computeAdvertised(registry));
    // A raw activate caller gets no bypass: outside-allow names never open the
    // gate, while the allowed match opens it at once.
    promote([OUTSIDE_ALLOW, "read_file"]);
    expect(activated.has(OUTSIDE_ALLOW)).toBe(false);
    expect(activated.has("read_file")).toBe(true);
    // Gate-only: the wire recompute ignores the fresh activation, so the
    // provider's cached prefix holds until the fold commits it.
    expect(JSON.stringify(computeAdvertised(registry))).toBe(before);
    expect(flushPromotions()).toBe(true);
    expect(computeAdvertised(registry).map((d) => d.name)).toContain(
      "read_file",
    );
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
});
