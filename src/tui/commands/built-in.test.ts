import { describe, it, expect } from "bun:test";
import "./built-in.js";
import { getCommand, listCommands } from "./registry.js";
import type { CommandContext } from "./registry.js";

const makeCtx = (model = "gpt-4o"): CommandContext & { current: string } => {
  const state = { current: model };
  return {
    current: state.current,
    getModel: () => state.current,
    setModel: (m) => { state.current = m; },
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
