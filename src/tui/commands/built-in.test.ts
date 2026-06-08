import { describe, it, expect } from "bun:test";
import "./built-in.js";
import { getCommand } from "./registry.js";
import type { CommandContext } from "./registry.js";

const makeCtx = (): CommandContext & { verbose: boolean } => {
  const state = { verbose: false };
  return {
    verbose: state.verbose,
    getVerbose: () => state.verbose,
    toggleVerbose: () => { state.verbose = !state.verbose; return state.verbose; },
    signalClear: () => {},
  };
};

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

describe("context view commands", () => {
  it("/diff switches the context panel to the diff view", () => {
    const ctx = makeCtx();
    expect(getCommand("diff")!.handler("", ctx)).toEqual({ type: "view", view: "diff" });
  });

  it("/plan switches the context panel to the plan view", () => {
    const ctx = makeCtx();
    expect(getCommand("plan")!.handler("", ctx)).toEqual({ type: "view", view: "plan" });
  });
});

describe("/verbose command", () => {
  it("is registered", () => {
    expect(getCommand("verbose")).toBeDefined();
  });

  it("toggles verbose state and reports it", () => {
    const ctx = makeCtx();
    const on = getCommand("verbose")!.handler("", ctx);
    expect(ctx.getVerbose()).toBe(true);
    if (on.type === "message") expect(on.text).toContain("on");
    const off = getCommand("verbose")!.handler("", ctx);
    expect(ctx.getVerbose()).toBe(false);
    if (off.type === "message") expect(off.text).toContain("off");
  });
});

describe("/agent command", () => {
  it("is registered", () => {
    expect(getCommand("agent")).toBeDefined();
  });

  it("opens the agent configuration modal", () => {
    const ctx = makeCtx();
    expect(getCommand("agent")!.handler("", ctx)).toEqual({ type: "modal", modal: "agent" });
  });
});

describe("/model alias", () => {
  it("is registered and opens the same /agent modal", () => {
    const ctx = makeCtx();
    expect(getCommand("model")).toBeDefined();
    expect(getCommand("model")!.handler("", ctx)).toEqual({ type: "modal", modal: "agent" });
  });
});

describe("/clear command", () => {
  it("returns a send action with text /clear", () => {
    const ctx = makeCtx();
    const result = getCommand("clear")!.handler("", ctx);
    expect(result).toEqual({ type: "send", text: "/clear" });
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
  it("returns a send action with text /new", () => {
    const ctx = makeCtx();
    const result = getCommand("new")!.handler("", ctx);
    expect(result).toEqual({ type: "send", text: "/new" });
  });

  it("calls signalClear", () => {
    let called = false;
    const ctx = makeCtx();
    ctx.signalClear = () => { called = true; };
    getCommand("new")!.handler("", ctx);
    expect(called).toBe(true);
  });
});
