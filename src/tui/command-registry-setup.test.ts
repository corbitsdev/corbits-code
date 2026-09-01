import { describe, test, expect } from "bun:test";
import { setUpCommandRegistry } from "./runner.js";
import { getCommand, listCommands } from "./commands/registry.js";
import type { PluginConfig } from "../config/settings.js";
import type { PluginModule } from "../plugins/loader.js";

// Built-in registration once rode on an import side effect; deleting its only
// importer emptied the registry with no type error and no failing test.
describe("session command registry setup", () => {
  test("populates built-in commands", () => {
    setUpCommandRegistry(undefined, []);

    const names = listCommands().map((c) => c.name);
    expect(names).toContain("help");
    expect(names).toContain("model");
    expect(names).toContain("settings");
    expect(names).toContain("clear");
    expect(getCommand("cost")).toBeDefined();
  });

  test("applies hidden commands from settings", () => {
    setUpCommandRegistry({ providers: {}, hiddenCommands: ["help"] }, []);
    expect(listCommands().map((c) => c.name)).not.toContain("help");
    expect(getCommand("help")).toBeDefined();
  });

  test("resolves plugin command candidates against live canonical config", () => {
    const plugin = (
      id: string,
      description: string,
      name = "live-config-command",
    ): PluginModule => ({
      manifest: { id, name: id, kind: "command" },
      origin: "user",
      commandPlugin: {
        commands: [
          {
            name,
            description,
            handler: () => ({ type: "message", text: description }),
          },
        ],
      },
    });
    let config: Record<string, PluginConfig> = {
      "disabled-command-plugin": { enabled: false },
      "enabled-command-plugin": { enabled: true },
      "help-collision-plugin": { enabled: true },
    };

    setUpCommandRegistry(
      { providers: {}, plugins: config },
      [
        plugin("disabled-command-plugin", "disabled"),
        plugin("enabled-command-plugin", "enabled"),
        plugin("help-collision-plugin", "plugin help", "help"),
      ],
      () => config,
    );

    expect(getCommand("live-config-command")?.description).toBe("enabled");
    expect(getCommand("live-config-command")?.handler("", { signalClear: () => {} })).toEqual({
      type: "message",
      text: "enabled",
    });
    expect(getCommand("help")?.description).not.toBe("plugin help");

    config = {
      ...config,
      "disabled-command-plugin": { enabled: true },
      "enabled-command-plugin": { enabled: false },
    };
    expect(getCommand("live-config-command")?.description).toBe("disabled");

    config = {
      ...config,
      "disabled-command-plugin": { enabled: false },
    };
    expect(getCommand("live-config-command")).toBeUndefined();
    expect(listCommands().map((command) => command.name)).not.toContain("live-config-command");
  });
});
