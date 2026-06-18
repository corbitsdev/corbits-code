import { test, expect } from "bun:test";
import { loadPluginEntry, loadPluginsFromPaths } from "../../src/plugins/loader.js";

test("loadPluginEntry loads a plugin directory by path and reads its manifest", async () => {
  const mod = await loadPluginEntry("plugins/exa");
  expect(mod).not.toBeNull();
  expect(mod!.manifest?.id).toBe("exa");
  expect(mod!.manifest?.kind).toBe("web");
  expect(typeof mod!.createWebProvider).toBe("function");
});

test("loadPluginEntry returns null for a non-existent path", async () => {
  expect(await loadPluginEntry("/no/such/plugin/here")).toBeNull();
});

test("loadPluginsFromPaths resolves relative paths against cwd and skips bad ones", async () => {
  const mods = await loadPluginsFromPaths(["plugins/exa", "does-not-exist"], process.cwd());
  expect(mods.map((m) => m.manifest?.id)).toEqual(["exa"]);
});
