import { describe, it, expect } from "bun:test";
import "./built-in.js";
import "./workflows.js";
import { getCommand } from "./registry.js";
import type { CommandContext } from "./registry.js";

const makeCtx = (): CommandContext & { verbose: boolean; auto: boolean } => {
  const state = { verbose: false, auto: false };
  return {
    verbose: state.verbose,
    auto: state.auto,
    getVerbose: () => state.verbose,
    toggleVerbose: () => { state.verbose = !state.verbose; return state.verbose; },
    getAuto: () => state.auto,
    toggleAuto: () => { state.auto = !state.auto; return state.auto; },
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

describe("/workflows command", () => {
  it("is registered", () => {
    expect(getCommand("workflows")).toBeDefined();
  });

  it("returns noop and opens the workflow picker", () => {
    let opened = false;
    const ctx = makeCtx();
    ctx.openWorkflowPicker = () => { opened = true; };
    const result = getCommand("workflows")!.handler("", ctx);
    expect(result).toEqual({ type: "noop" });
    expect(opened).toBe(true);
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

describe("/auto command", () => {
  it("is registered", () => {
    expect(getCommand("auto")).toBeDefined();
  });

  it("toggles auto state and reports it", () => {
    const ctx = makeCtx();
    const on = getCommand("auto")!.handler("", ctx);
    expect(ctx.getAuto()).toBe(true);
    if (on.type === "message") expect(on.text).toContain("on");
    const off = getCommand("auto")!.handler("", ctx);
    expect(ctx.getAuto()).toBe(false);
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

describe("/model command", () => {
  it("opens the agent configuration modal", () => {
    expect(getCommand("model")!.handler("", makeCtx())).toEqual({ type: "modal", modal: "agent" });
  });

  it("/agent alias also opens the agent configuration modal", () => {
    expect(getCommand("agent")!.handler("", makeCtx())).toEqual({ type: "modal", modal: "agent" });
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
