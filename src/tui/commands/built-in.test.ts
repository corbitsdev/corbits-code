import { describe, it, expect } from "bun:test";
import "./built-in.js";
import { getCommand } from "./registry.js";
import type { CommandContext } from "./registry.js";

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

  it("/scope is not registered (workflows live under enabled command plugins, e.g. /linear scope)", () => {
    expect(getCommand("scope")).toBeUndefined();
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
