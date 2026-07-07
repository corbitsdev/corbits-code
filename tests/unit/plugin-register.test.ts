import { test, expect } from "bun:test";
import { registerCommandPlugins, isEnabledCommandPlugin } from "../../src/plugins/register.js";
import type { PluginModule } from "../../src/plugins/loader.js";

function cmdModule(id: string): PluginModule {
  return {
    manifest: { id, name: id, kind: "command" },
    commandPlugin: { commands: [{ name: id, description: "d", handler: () => ({ type: "noop" }) }] },
  };
}

test("isEnabledCommandPlugin requires command kind + export + enabled", () => {
  expect(isEnabledCommandPlugin(cmdModule("rega"), { rega: { enabled: true } })).toBe(true);
  expect(isEnabledCommandPlugin(cmdModule("rega"), { rega: { enabled: false } })).toBe(false);
  expect(isEnabledCommandPlugin(cmdModule("rega"), {})).toBe(false);
  expect(isEnabledCommandPlugin({ manifest: { id: "w", name: "w", kind: "web" } }, { w: { enabled: true } })).toBe(false);
  expect(isEnabledCommandPlugin({ commandPlugin: { commands: [] } }, {})).toBe(false); // no manifest
});

test("isEnabledCommandPlugin allows agent-kind plugins to contribute commands (mixed plugins)", () => {
  const agentWithCmd: PluginModule = {
    manifest: { id: "mix", name: "mix", kind: "agent" },
    commandPlugin: { commands: [{ name: "mix", description: "d", handler: () => ({ type: "noop" }) }] },
  };
  expect(isEnabledCommandPlugin(agentWithCmd, { mix: { enabled: true } })).toBe(true);
  // web/tool kinds still do not auto-wire commands.
  const webWithCmd: PluginModule = {
    manifest: { id: "w", name: "w", kind: "web" },
    commandPlugin: { commands: [{ name: "w", description: "d", handler: () => ({ type: "noop" }) }] },
  };
  expect(isEnabledCommandPlugin(webWithCmd, { w: { enabled: true } })).toBe(false);
});

test("registerCommandPlugins registers only enabled command plugins", () => {
  const mods = [cmdModule("reg-on"), cmdModule("reg-off")];
  const registered = registerCommandPlugins(mods, { "reg-on": { enabled: true } });
  expect(registered).toEqual(["reg-on"]);
});
