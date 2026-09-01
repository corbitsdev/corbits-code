import { test, expect } from "bun:test";
import {
  registerCommandPlugins,
  isEnabledCommandPlugin,
  enablePluginConfig,
  isPluginEnabled,
  isPluginModuleEnabled,
} from "../../src/plugins/register.js";
import type { PluginModule } from "../../src/plugins/loader.js";
import { getCommand } from "../../src/tui/commands/registry.js";

function cmdModule(id: string, extra: Partial<PluginModule> = {}): PluginModule {
  return {
    manifest: { id, name: id, kind: "command" },
    commandPlugin: {
      commands: [{ name: id, description: "d", handler: () => ({ type: "noop" }) }],
    },
    ...extra,
  };
}

test("isEnabledCommandPlugin requires command kind + export + enabled", () => {
  expect(isEnabledCommandPlugin(cmdModule("rega"), { rega: { enabled: true } })).toBe(true);
  expect(isEnabledCommandPlugin(cmdModule("rega"), { rega: { enabled: false } })).toBe(false);
  expect(isEnabledCommandPlugin(cmdModule("rega"), {})).toBe(false);
  expect(
    isEnabledCommandPlugin(
      { manifest: { id: "w", name: "w", kind: "web" } },
      { w: { enabled: true } },
    ),
  ).toBe(false);
  expect(isEnabledCommandPlugin({ commandPlugin: { commands: [] } }, {})).toBe(false); // no manifest
});

test("isEnabledCommandPlugin allows agent-kind plugins to contribute commands (mixed plugins)", () => {
  const agentWithCmd: PluginModule = {
    manifest: { id: "mix", name: "mix", kind: "agent" },
    commandPlugin: {
      commands: [{ name: "mix", description: "d", handler: () => ({ type: "noop" }) }],
    },
  };
  expect(isEnabledCommandPlugin(agentWithCmd, { mix: { enabled: true } })).toBe(true);
  // web/tool kinds still do not auto-wire commands.
  const webWithCmd: PluginModule = {
    manifest: { id: "w", name: "w", kind: "web" },
    commandPlugin: {
      commands: [{ name: "w", description: "d", handler: () => ({ type: "noop" }) }],
    },
  };
  expect(isEnabledCommandPlugin(webWithCmd, { w: { enabled: true } })).toBe(false);
});

test("registerCommandPlugins registers only enabled command plugins", () => {
  const mods = [cmdModule("reg-on"), cmdModule("reg-off")];
  const registered = registerCommandPlugins(mods, { "reg-on": { enabled: true } });
  expect(registered).toEqual(["reg-on"]);
});

test("registerCommandPlugins restores a disabled-at-startup command without re-registering", () => {
  const mods = [cmdModule("reg-off-live")];
  const config: Record<string, { enabled: boolean }> = { "reg-off-live": { enabled: false } };
  const registered = registerCommandPlugins(mods, config);
  expect(registered).toEqual([]);
  expect(getCommand("reg-off-live")).toBeUndefined();

  config["reg-off-live"] = { enabled: true };
  expect(getCommand("reg-off-live")).toBeDefined();
});

test("enablePluginConfig marks enabled and preserves credentials/consented", () => {
  // Path-add must leave plugins[id].enabled === true so restart re-wires commands.
  expect(isPluginEnabled({}, "path-cmd")).toBe(false);
  const enabled = enablePluginConfig({}, "path-cmd");
  expect(enabled).toEqual({ "path-cmd": { enabled: true } });
  expect(isPluginEnabled(enabled, "path-cmd")).toBe(true);
  expect(isEnabledCommandPlugin(cmdModule("path-cmd"), enabled)).toBe(true);

  const withCreds = enablePluginConfig(
    { "path-cmd": { enabled: false, consented: true, credentials: { apiKey: "k" } } },
    "path-cmd",
  );
  expect(withCreds["path-cmd"]).toEqual({
    enabled: true,
    consented: true,
    credentials: { apiKey: "k" },
  });
});

test("isPluginEnabled stays strict: missing settings entry is disabled", () => {
  expect(isPluginEnabled({}, "any")).toBe(false);
  expect(isPluginEnabled({ any: {} }, "any")).toBe(false);
  expect(isPluginEnabled({ any: { enabled: false } }, "any")).toBe(false);
});

test("isPluginModuleEnabled: explicit true/false win over defaultEnabled", () => {
  const repoOn: PluginModule = {
    origin: "repo",
    manifest: { id: "skills", name: "skills", kind: "command", defaultEnabled: true },
  };
  expect(isPluginModuleEnabled(repoOn, { skills: { enabled: true } })).toBe(true);
  expect(isPluginModuleEnabled(repoOn, { skills: { enabled: false } })).toBe(false);

  const repoOffFlag: PluginModule = {
    origin: "repo",
    manifest: { id: "skills", name: "skills", kind: "command", defaultEnabled: false },
  };
  expect(isPluginModuleEnabled(repoOffFlag, { skills: { enabled: true } })).toBe(true);
});

test("isPluginModuleEnabled: missing settings + repo + defaultEnabled is on", () => {
  const repoOn: PluginModule = {
    origin: "repo",
    manifest: { id: "skills", name: "skills", kind: "command", defaultEnabled: true },
  };
  expect(isPluginModuleEnabled(repoOn, {})).toBe(true);
  expect(isPluginModuleEnabled(repoOn, { skills: {} })).toBe(true);
});

test("isPluginModuleEnabled: missing settings + repo without flag is off", () => {
  const repoNoFlag: PluginModule = {
    origin: "repo",
    manifest: { id: "skills", name: "skills", kind: "command" },
  };
  expect(isPluginModuleEnabled(repoNoFlag, {})).toBe(false);
  const repoFalse: PluginModule = {
    origin: "repo",
    manifest: { id: "skills", name: "skills", kind: "command", defaultEnabled: false },
  };
  expect(isPluginModuleEnabled(repoFalse, {})).toBe(false);
});

test("isPluginModuleEnabled: marketplace/path/user defaultEnabled is ignored", () => {
  const flagged = {
    manifest: { id: "mkt", name: "mkt", kind: "command" as const, defaultEnabled: true },
  };
  expect(isPluginModuleEnabled({ ...flagged, origin: "user" }, {})).toBe(false);
  expect(isPluginModuleEnabled({ ...flagged, origin: "path" }, {})).toBe(false);
  expect(isPluginModuleEnabled({ ...flagged, origin: "project" }, {})).toBe(false);
  expect(isPluginModuleEnabled(flagged, {})).toBe(false);
});

test("isEnabledCommandPlugin routes through isPluginModuleEnabled", () => {
  const repoCmd = cmdModule("skills", {
    origin: "repo",
    manifest: { id: "skills", name: "skills", kind: "command", defaultEnabled: true },
  });
  expect(isEnabledCommandPlugin(repoCmd, {})).toBe(true);
  expect(isEnabledCommandPlugin(repoCmd, { skills: { enabled: false } })).toBe(false);
});
