import { describe, test, expect } from "bun:test";
import { setUpCommandRegistry } from "./runner.js";
import { getCommand, listCommands } from "./commands/registry.js";

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
    expect(getCommand("goal")).toBeDefined();
  });

  test("hides tier commands until a tier is configured", () => {
    setUpCommandRegistry(undefined, []);
    expect(listCommands().map((c) => c.name)).not.toContain("fast");

    setUpCommandRegistry({ providers: {}, tiers: { fast: { provider: "p", model: "m" } } }, []);
    expect(listCommands().map((c) => c.name)).toContain("fast");
  });

  test("applies hidden commands from settings", () => {
    setUpCommandRegistry({ providers: {}, hiddenCommands: ["help"] }, []);
    expect(listCommands().map((c) => c.name)).not.toContain("help");
    expect(getCommand("help")).toBeDefined();
  });
});
