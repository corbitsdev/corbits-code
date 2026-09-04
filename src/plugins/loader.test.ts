import { describe, test, expect } from "bun:test";
import { dedupePluginModules, type PluginModule } from "./loader.js";
import { isPluginModuleEnabled } from "./register.js";
import { disablePluginSettings } from "./uninstall.js";

function repoDefaultEnabled(id: string): PluginModule {
  return {
    manifest: { id, name: id, kind: "agent", defaultEnabled: true },
    origin: "repo",
  };
}

function userInstall(id: string): PluginModule {
  return {
    manifest: { id, name: id, kind: "agent" },
    origin: "user",
    source: "claude",
  };
}

describe("dedupePluginModules", () => {
  test("last occurrence wins for content", () => {
    const repo = repoDefaultEnabled("scout");
    const user = userInstall("scout");
    const [result] = dedupePluginModules([repo, user]);
    expect(result).toMatchObject({ origin: "user", source: "claude" });
  });

  // CL-6716: a later non-repo install with the same id as a repo
  // defaultEnabled plugin must not silently turn the bundled default off.
  test("stamps shadowedRepoDefaultEnabled when a non-repo module shadows a repo defaultEnabled id", () => {
    const repo = repoDefaultEnabled("scout");
    const user = userInstall("scout");
    const [result] = dedupePluginModules([repo, user]);
    expect(result!.shadowedRepoDefaultEnabled).toBe(true);
  });

  test("does not stamp shadowedRepoDefaultEnabled when the repo module wasn't defaultEnabled", () => {
    const repo: PluginModule = {
      manifest: { id: "scout", name: "scout", kind: "agent" },
      origin: "repo",
    };
    const user = userInstall("scout");
    const [result] = dedupePluginModules([repo, user]);
    expect(result!.shadowedRepoDefaultEnabled).toBeUndefined();
  });

  test("does not stamp unrelated ids", () => {
    const repo = repoDefaultEnabled("scout");
    const other = userInstall("other");
    const result = dedupePluginModules([repo, other]);
    expect(
      result.find((m) => m.manifest?.id === "other")!.shadowedRepoDefaultEnabled,
    ).toBeUndefined();
  });

  test("propagates the shadow stamp through a chain of later installs", () => {
    const repo = repoDefaultEnabled("scout");
    const user = userInstall("scout");
    const path: PluginModule = {
      manifest: { id: "scout", name: "scout", kind: "agent" },
      origin: "path",
    };
    const [result] = dedupePluginModules([repo, user, path]);
    expect(result).toMatchObject({ origin: "path" });
    expect(result!.shadowedRepoDefaultEnabled).toBe(true);
  });
});

describe("isPluginModuleEnabled with dedupe shadowing", () => {
  test("a same-id later install stays enabled by default after shadowing a repo defaultEnabled plugin", () => {
    const repo = repoDefaultEnabled("scout");
    const user = userInstall("scout");
    const [survivor] = dedupePluginModules([repo, user]);
    expect(isPluginModuleEnabled(survivor!, {})).toBe(true);
  });

  test("an explicit disable in settings still wins over the preserved default-on", () => {
    const repo = repoDefaultEnabled("scout");
    const user = userInstall("scout");
    const [survivor] = dedupePluginModules([repo, user]);
    expect(isPluginModuleEnabled(survivor!, { scout: { enabled: false } })).toBe(false);
  });

  test("disablePluginSettings then isPluginModuleEnabled is false for shadowedRepoDefaultEnabled", () => {
    const repo = repoDefaultEnabled("scout");
    const user = userInstall("scout");
    const [survivor] = dedupePluginModules([repo, user]);
    expect(survivor!.shadowedRepoDefaultEnabled).toBe(true);
    const plugins = disablePluginSettings({}, "scout");
    expect(plugins.scout?.enabled).toBe(false);
    expect(isPluginModuleEnabled(survivor!, plugins)).toBe(false);
  });

  test("without dedupe shadowing, a plain user-origin module needs an explicit enable", () => {
    const user = userInstall("scout");
    expect(isPluginModuleEnabled(user, {})).toBe(false);
  });
});
