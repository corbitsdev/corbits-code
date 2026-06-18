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

import { dedupePluginModules } from "../../src/plugins/loader.js";
import { parsePluginManifest } from "../../src/plugins/manifest.js";
import type { PluginModule } from "../../src/plugins/loader.js";

test("manifest requires a kind", () => {
  expect(parsePluginManifest({ id: "x", name: "X", kind: "web" })).not.toBeNull();
  expect(parsePluginManifest({ id: "x", name: "X" })).toBeNull();
  expect(parsePluginManifest({ id: "x", name: "X", kind: "bogus" })).toBeNull();
});

test("dedupePluginModules keeps the last module per id (path > user > repo)", () => {
  const repo: PluginModule = { manifest: { id: "dup", name: "Repo", kind: "command" }, commandPlugin: { commands: [] } };
  const user: PluginModule = { manifest: { id: "dup", name: "User", kind: "command" }, commandPlugin: { commands: [] } };
  const other: PluginModule = { manifest: { id: "other", name: "Other", kind: "web" } };
  const noManifest: PluginModule = { commandPlugin: { commands: [] } };
  const out = dedupePluginModules([repo, other, user, noManifest]);
  expect(out.find((m) => m.manifest?.id === "dup")?.manifest?.name).toBe("User");
  expect(out.filter((m) => m.manifest?.id === "dup").length).toBe(1);
  expect(out).toContain(noManifest); // kept (no id)
  expect(out.length).toBe(3);
});

test("loadPluginEntry maps a default export to the factory for the manifest kind", async () => {
  const toolMod = await loadPluginEntry("plugins/example-tool");
  expect(toolMod?.manifest?.kind).toBe("tool");
  expect(typeof toolMod?.createToolPlugin).toBe("function");
  expect(toolMod?.createWebProvider).toBeUndefined();

  const webMod = await loadPluginEntry("plugins/exa");
  expect(webMod?.manifest?.kind).toBe("web");
  expect(typeof webMod?.createWebProvider).toBe("function");
  expect(webMod?.createToolPlugin).toBeUndefined();
});
