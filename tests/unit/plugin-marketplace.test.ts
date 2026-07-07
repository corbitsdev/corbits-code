import { test, expect } from "bun:test";
import { loadPluginsFromPaths } from "../../src/plugins/loader.js";

test("a marketplace path expands to its declared member plugins", async () => {
  const mods = await loadPluginsFromPaths(["tests/fixtures/marketplace"], process.cwd());
  const ids = mods.map((m) => m.manifest?.id).sort();
  expect(ids).toEqual(["alpha", "beta"]);
});

test("marketplace members load with their full data (agents + tagged skills)", async () => {
  const mods = await loadPluginsFromPaths(["tests/fixtures/marketplace"], process.cwd());
  const alpha = mods.find((m) => m.manifest?.id === "alpha");
  expect(alpha?.manifest?.kind).toBe("command"); // skills-only with a tagged skill
  expect(alpha?.commandPlugin?.commands.map((c) => c.name)).toEqual(["alpha-skill"]);

  const beta = mods.find((m) => m.manifest?.id === "beta");
  expect(beta?.manifest?.kind).toBe("agent"); // has an agent
  expect(beta?.agentPlugin?.agents?.length).toBe(1);
});

test("a normal plugin directory is not expanded (no marketplace.json, no plugins/ root)", async () => {
  const mods = await loadPluginsFromPaths(["tests/fixtures/plugins/example-commands"], process.cwd());
  expect(mods.length).toBe(1);
  expect(mods[0]!.manifest?.id).toBe("example-commands");
});
