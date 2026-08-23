import { describe, it, expect, afterEach } from "bun:test";

import {
  registerCommand,
  registerCommandPlugin,
  getCommand,
  listCommands,
  setHiddenCommands,
} from "./registry.js";
import type { CommandContext } from "./registry.js";

const ctx: CommandContext = {
  signalClear: () => {},
};

afterEach(() => {
  // Reset hidden commands between tests so they don't bleed.
  setHiddenCommands([]);
});

describe("command registry", () => {
  it("registers and retrieves a command", () => {
    registerCommand({
      name: "test-get",
      description: "a test command",
      handler: (_args, _ctx) => ({ type: "noop" }),
    });
    const def = getCommand("test-get");
    expect(def).toBeDefined();
    expect(def?.name).toBe("test-get");
  });

  it("returns undefined for unknown command", () => {
    expect(getCommand("not-a-real-command-xyz")).toBeUndefined();
  });

  it("lists registered commands sorted by name", () => {
    registerCommand({
      name: "zzz-last",
      description: "last",
      handler: (_args, _ctx) => ({ type: "noop" }),
    });
    registerCommand({
      name: "aaa-first",
      description: "first",
      handler: (_args, _ctx) => ({ type: "noop" }),
    });
    const names = listCommands().map((c) => c.name);
    const idx1 = names.indexOf("aaa-first");
    const idx2 = names.indexOf("zzz-last");
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThanOrEqual(0);
    expect(idx1).toBeLessThan(idx2);
  });

  it("skips a command whose name is already registered (first-wins)", () => {
    registerCommand({
      name: "first-wins-cmd",
      description: "built-in",
      handler: () => ({ type: "message", text: "built-in" }),
    });
    registerCommand({
      name: "first-wins-cmd",
      description: "plugin",
      handler: () => ({ type: "message", text: "plugin" }),
    });
    const def = getCommand("first-wins-cmd");
    expect(def?.description).toBe("built-in");
    expect(def?.handler("", ctx)).toEqual({ type: "message", text: "built-in" });
  });

  it("invokes handler with args and context", () => {
    let receivedArgs = "";
    let clearCalled = false;
    registerCommand({
      name: "test-handler",
      description: "handler test",
      handler: (args, c) => {
        receivedArgs = args;
        c.signalClear();
        return { type: "noop" };
      },
    });
    getCommand("test-handler")?.handler("hello world", {
      signalClear: () => {
        clearCalled = true;
      },
    });
    expect(receivedArgs).toBe("hello world");
    expect(clearCalled).toBe(true);
  });
});

describe("registerCommandPlugin", () => {
  it("registers all commands from a plugin", () => {
    registerCommandPlugin({
      commands: [
        { name: "plugin-cmd-a", description: "a", handler: () => ({ type: "noop" }) },
        { name: "plugin-cmd-b", description: "b", handler: () => ({ type: "noop" }) },
      ],
    });
    expect(getCommand("plugin-cmd-a")).toBeDefined();
    expect(getCommand("plugin-cmd-b")).toBeDefined();
  });
});

describe("setHiddenCommands", () => {
  it("hides named commands from listCommands", () => {
    registerCommand({
      name: "visible-cmd",
      description: "visible",
      handler: () => ({ type: "noop" }),
    });
    registerCommand({
      name: "hidden-cmd",
      description: "hidden",
      handler: () => ({ type: "noop" }),
    });

    setHiddenCommands(["hidden-cmd"]);

    const names = listCommands().map((c) => c.name);
    expect(names).toContain("visible-cmd");
    expect(names).not.toContain("hidden-cmd");
  });

  it("getCommand still returns hidden commands", () => {
    registerCommand({
      name: "hidden-but-callable",
      description: "x",
      handler: () => ({ type: "noop" }),
    });
    setHiddenCommands(["hidden-but-callable"]);
    expect(getCommand("hidden-but-callable")).toBeDefined();
  });

  it("clearing hidden set restores visibility", () => {
    registerCommand({ name: "restore-cmd", description: "x", handler: () => ({ type: "noop" }) });
    setHiddenCommands(["restore-cmd"]);
    expect(listCommands().map((c) => c.name)).not.toContain("restore-cmd");

    setHiddenCommands([]);
    expect(listCommands().map((c) => c.name)).toContain("restore-cmd");
  });
});
