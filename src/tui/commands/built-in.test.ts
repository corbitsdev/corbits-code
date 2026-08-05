import { describe, it, expect } from "bun:test";
import "./built-in.js";
import { getCommand, listCommands } from "./registry.js";
import type { CommandContext } from "./registry.js";
import { setConfiguredTiers } from "./built-in.js";

const makeCtx = (): CommandContext => ({
  signalClear: () => {},
});

describe("/help command", () => {
  it("is registered", () => {
    expect(getCommand("help")).toBeDefined();
  });

  it("requests the help overlay", () => {
    const ctx = makeCtx();
    const result = getCommand("help")!.handler("", ctx);
    expect(result).toEqual({ type: "overlay", overlay: "help" });
  });
});

describe("removed commands", () => {
  it("does not register verbose or diff", () => {
    expect(getCommand("verbose")).toBeUndefined();
    expect(getCommand("diff")).toBeUndefined();
  });

  it("/workflows is not registered", () => {
    expect(getCommand("workflows")).toBeUndefined();
  });

  it("/scope is not registered (slash commands live under enabled command plugins, e.g. a namespaced /ns sub)", () => {
    expect(getCommand("scope")).toBeUndefined();
  });

  it("/login is not registered (connect from /model)", () => {
    expect(getCommand("login")).toBeUndefined();
  });
});

describe("removed approval command", () => {
  it("is not registered", () => {
    expect(getCommand("auto")).toBeUndefined();
  });
});

describe("/model command", () => {
  it("is registered", () => {
    expect(getCommand("model")).toBeDefined();
  });

  it("opens the agent configuration modal", () => {
    expect(getCommand("model")!.handler("", makeCtx())).toEqual({ type: "modal", modal: "agent" });
  });

  it("/agent alias is not registered", () => {
    expect(getCommand("agent")).toBeUndefined();
  });
});

describe("/clear command", () => {
  it("returns a local message and does not send to the agent", () => {
    const ctx = makeCtx();
    const result = getCommand("clear")!.handler("", ctx);
    expect(result).toEqual({ type: "message", text: "Started a fresh session." });
  });

  it("calls signalClear", () => {
    let called = false;
    const ctx = makeCtx();
    ctx.signalClear = () => { called = true; };
    getCommand("clear")!.handler("", ctx);
    expect(called).toBe(true);
  });
});

describe("/new command", () => {
  it("returns a local message and does not send to the agent", () => {
    const ctx = makeCtx();
    const result = getCommand("new")!.handler("", ctx);
    expect(result).toEqual({ type: "message", text: "Started a fresh session." });
  });

  it("calls signalClear", () => {
    let called = false;
    const ctx = makeCtx();
    ctx.signalClear = () => { called = true; };
    getCommand("new")!.handler("", ctx);
    expect(called).toBe(true);
  });
});

describe("tier commands", () => {
  it("registers a slash command for each provider tier", () => {
    expect(getCommand("fast")).toBeDefined();
    expect(getCommand("standard")).toBeDefined();
    expect(getCommand("clever")).toBeDefined();
  });

  it("each emits a tier-switch intent carrying its tier name", () => {
    for (const tier of ["fast", "standard", "clever"] as const) {
      expect(getCommand(tier)!.handler("", makeCtx())).toEqual({ type: "tier", tier });
    }
  });

  it("are hidden from the menu until configured, then appear", () => {
    // Reset to nothing configured: no tier command surfaces in the menu.
    setConfiguredTiers({});
    let names = listCommands().map((c) => c.name);
    expect(names).not.toContain("fast");
    expect(names).not.toContain("standard");
    expect(names).not.toContain("clever");

    // Still callable directly — visibility is display-only, never a hard gate.
    expect(getCommand("fast")).toBeDefined();

    setConfiguredTiers({ fast: { provider: "fp", model: "fp-large" } });
    names = listCommands().map((c) => c.name);
    expect(names).toContain("fast");
    expect(names).not.toContain("standard");
    expect(names).not.toContain("clever");

    setConfiguredTiers({});
  });
});
