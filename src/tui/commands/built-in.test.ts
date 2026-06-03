import { describe, it, expect } from "bun:test";
import "./built-in.js";
import { getCommand, listCommands } from "./registry.js";
import type { CommandContext } from "./registry.js";

const makeCtx = (model = "gpt-4o"): CommandContext & { current: string; verbose: boolean } => {
  const state = { current: model, verbose: false };
  return {
    current: state.current,
    verbose: state.verbose,
    getModel: () => state.current,
    setModel: (m) => { state.current = m; },
    getVerbose: () => state.verbose,
    toggleVerbose: () => { state.verbose = !state.verbose; return state.verbose; },
  };
};

describe("/help command", () => {
  it("is registered", () => {
    expect(getCommand("help")).toBeDefined();
  });

  it("returns a message listing all commands", () => {
    const ctx = makeCtx();
    const result = getCommand("help")!.handler("", ctx);
    expect(result.type).toBe("message");
    if (result.type === "message") {
      expect(result.text).toContain("/help");
      expect(result.text).toContain("/model");
    }
  });

  it("lists every registered command", () => {
    const ctx = makeCtx();
    const result = getCommand("help")!.handler("", ctx);
    const commands = listCommands();
    if (result.type === "message") {
      for (const cmd of commands) {
        expect(result.text).toContain(`/${cmd.name}`);
      }
    }
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

describe("/model command", () => {
  it("is registered", () => {
    expect(getCommand("model")).toBeDefined();
  });

  it("returns current model when called with no args", () => {
    const ctx = makeCtx("my-model");
    const result = getCommand("model")!.handler("", ctx);
    expect(result.type).toBe("message");
    if (result.type === "message") {
      expect(result.text).toContain("my-model");
    }
  });

  it("sets the model when given an argument", () => {
    const ctx = makeCtx("old-model");
    const result = getCommand("model")!.handler("new-model", ctx);
    expect(ctx.getModel()).toBe("new-model");
    expect(result.type).toBe("message");
    if (result.type === "message") {
      expect(result.text).toContain("new-model");
    }
  });
});
