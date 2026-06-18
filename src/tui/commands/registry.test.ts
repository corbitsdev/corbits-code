import { describe, it, expect, beforeEach } from "bun:test";

// Re-import module fresh each test by clearing the registry manually.
// We test the exported API directly.
import { registerCommand, getCommand, listCommands } from "./registry.js";
import type { CommandContext } from "./registry.js";

const ctx: CommandContext = {
  signalClear: () => {},
};

describe("command registry", () => {
  // Each test registers its own uniquely-named commands to avoid order-dependence.

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
    getCommand("test-handler")?.handler("hello world", { signalClear: () => { clearCalled = true; } });
    expect(receivedArgs).toBe("hello world");
    expect(clearCalled).toBe(true);
  });
});
