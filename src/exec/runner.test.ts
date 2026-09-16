import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DIRECTOR_REGISTRY } from "../agent/directors/registry.js";
import { createAdvertisedToolset } from "../session/assemble-runtime.js";
import {
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
    expect(computeAdvertised(registry).map((d) => d.name)).toContain(
      "read_file",
    );
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
