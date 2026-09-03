import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginConfig } from "../config/settings.js";
import {
  classifyPluginRemove,
  deleteOwnedPluginDir,
  disableBundledPluginSettings,
  isOwnedDiskInstall,
  nextPluginPathsAfterRemove,
  ownedDiskOriginRoot,
  projectPluginsRoot,
  userPluginsRoot,
} from "./uninstall.js";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("deleteOwnedPluginDir", () => {
  test("owned dir under fake user root is deleted", async () => {
    const home = await tempDir("uninstall-user-");
    const root = userPluginsRoot(home);
    const plugin = join(root, "exa");
    await mkdir(plugin, { recursive: true });
    await writeFile(join(plugin, "manifest.json"), "{}");
    const result = await deleteOwnedPluginDir({
      pluginPath: plugin,
      originRoot: root,
      claudeRoot: join(home, ".claude"),
    });
    expect(result).toEqual({ ok: true });
    expect(await exists(plugin)).toBe(false);
    expect(await exists(root)).toBe(true);
  });

  test("path outside origin root is refused", async () => {
    const home = await tempDir("uninstall-outside-");
    const root = userPluginsRoot(home);
    await mkdir(root, { recursive: true });
    const outside = join(home, "other", "exa");
    await mkdir(outside, { recursive: true });
    const result = await deleteOwnedPluginDir({
      pluginPath: outside,
      originRoot: root,
      claudeRoot: join(home, ".claude"),
    });
    expect(result.ok).toBe(false);
    expect(await exists(outside)).toBe(true);
  });

  test("path equal to plugins root is refused", async () => {
    const home = await tempDir("uninstall-root-");
    const root = userPluginsRoot(home);
    await mkdir(root, { recursive: true });
    const result = await deleteOwnedPluginDir({
      pluginPath: root,
      originRoot: root,
      claudeRoot: join(home, ".claude"),
    });
    expect(result.ok).toBe(false);
    expect(await exists(root)).toBe(true);
  });

  test("path under .claude/plugins is refused", async () => {
    const home = await tempDir("uninstall-claude-");
    const root = userPluginsRoot(home);
    const claudeRoot = join(home, ".claude");
    const plugin = join(claudeRoot, "plugins", "market");
    await mkdir(root, { recursive: true });
    await mkdir(plugin, { recursive: true });
    const result = await deleteOwnedPluginDir({
      pluginPath: plugin,
      originRoot: root,
      claudeRoot,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("~/.claude");
    expect(await exists(plugin)).toBe(true);
  });

  test("project: delete only inside <cwd>/.corbits/plugins/", async () => {
    const cwd = await tempDir("uninstall-project-");
    const root = projectPluginsRoot(cwd);
    const inside = join(root, "local");
    const outside = join(cwd, "not-plugins", "local");
    await mkdir(inside, { recursive: true });
    await mkdir(outside, { recursive: true });
    const claudeRoot = join(cwd, "home", ".claude");
    expect(
      await deleteOwnedPluginDir({ pluginPath: inside, originRoot: root, claudeRoot }),
    ).toEqual({ ok: true });
    expect(await exists(inside)).toBe(false);
    const refused = await deleteOwnedPluginDir({
      pluginPath: outside,
      originRoot: root,
      claudeRoot,
    });
    expect(refused.ok).toBe(false);
    expect(await exists(outside)).toBe(true);
  });

  test("already-missing path returns { ok: true }", async () => {
    const home = await tempDir("uninstall-missing-");
    const root = userPluginsRoot(home);
    await mkdir(root, { recursive: true });
    const missing = join(root, "gone");
    const result = await deleteOwnedPluginDir({
      pluginPath: missing,
      originRoot: root,
      claudeRoot: join(home, ".claude"),
    });
    expect(result).toEqual({ ok: true });
    expect(await exists(missing)).toBe(false);
  });
});

describe("isOwnedDiskInstall", () => {
  test("project path is owned only for the passed cwd", () => {
    const cwd = "/tmp/project-a";
    const pluginPath = join(projectPluginsRoot(cwd), "local");
    expect(isOwnedDiskInstall({ origin: "project", pluginPath, home: "/tmp/home", cwd })).toBe(
      true,
    );
    expect(
      isOwnedDiskInstall({
        origin: "project",
        pluginPath,
        home: "/tmp/home",
        cwd: "/tmp/other",
      }),
    ).toBe(false);
  });

  test("~/.claude is never owned", () => {
    const home = "/tmp/home";
    const cwd = "/tmp/cwd";
    const pluginPath = join(home, ".claude", "plugins", "exa");
    expect(isOwnedDiskInstall({ origin: "user", pluginPath, home, cwd })).toBe(false);
    expect(isOwnedDiskInstall({ origin: "project", pluginPath, home, cwd })).toBe(false);
  });

  test("path origin under userPluginsRoot is owned", () => {
    const home = "/tmp/home";
    const cwd = "/tmp/cwd";
    const pluginPath = join(userPluginsRoot(home), "exa");
    expect(isOwnedDiskInstall({ origin: "path", pluginPath, home, cwd })).toBe(true);
    expect(ownedDiskOriginRoot({ pluginPath, home, cwd })).toBe(userPluginsRoot(home));
  });

  test("path origin under /tmp is not owned", () => {
    const home = "/tmp/home";
    const cwd = "/tmp/cwd";
    const pluginPath = "/tmp/elsewhere/my-plugin";
    expect(isOwnedDiskInstall({ origin: "path", pluginPath, home, cwd })).toBe(false);
    expect(ownedDiskOriginRoot({ pluginPath, home, cwd })).toBeUndefined();
  });
});

describe("classifyPluginRemove", () => {
  test("origin and owned classify into one shared action", () => {
    expect(classifyPluginRemove({ origin: "repo", owned: false })).toBe("disable-bundled");
    expect(classifyPluginRemove({ origin: "repo", owned: true })).toBe("disable-bundled");
    expect(classifyPluginRemove({ origin: "user", owned: false })).toBe("disable-unowned-user");
    expect(classifyPluginRemove({ origin: "user", owned: true })).toBe("delete-owned");
    expect(classifyPluginRemove({ origin: "project", owned: true })).toBe("delete-owned");
    expect(classifyPluginRemove({ origin: "project", owned: false })).toBe("cannot");
    expect(classifyPluginRemove({ origin: "path", owned: false })).toBe("remove-path");
    expect(classifyPluginRemove({ origin: "path", owned: true })).toBe("delete-owned");
  });
});

describe("plugin remove settings policy", () => {
  test("owned remove writes enabled:false and keeps plugins[id]", () => {
    const plugins: Record<string, PluginConfig> = {
      exa: { enabled: true, credentials: { apiKey: "k" } },
      other: { enabled: true },
    };
    const next = disableBundledPluginSettings(plugins, "exa");
    expect(next.exa?.enabled).toBe(false);
    expect(next.exa?.credentials).toEqual({ apiKey: "k" });
    expect(next.other).toEqual({ enabled: true });
    expect("exa" in next).toBe(true);
  });

  test("repo writes enabled:false", () => {
    const plugins: Record<string, PluginConfig> = {
      "corbits-skills": { enabled: true },
    };
    expect(disableBundledPluginSettings(plugins, "corbits-skills")).toEqual({
      "corbits-skills": { enabled: false },
    });
    expect(disableBundledPluginSettings({}, "corbits-skills")).toEqual({
      "corbits-skills": { enabled: false },
    });
  });

  test("disableBundledPluginSettings keeps plugins[id].enabled === false", () => {
    const plugins: Record<string, PluginConfig> = {
      exa: { enabled: true, credentials: { apiKey: "k" } },
    };
    const next = disableBundledPluginSettings(plugins, "exa");
    expect(next.exa?.enabled).toBe(false);
    expect(next.exa?.credentials).toEqual({ apiKey: "k" });
    expect("exa" in next).toBe(true);
  });

  test("path drops unique pluginPaths and keeps a shared marketplace root", async () => {
    const unique = await nextPluginPathsAfterRemove({
      pluginPaths: ["/tmp/my-plugin"],
      pluginPath: "/tmp/my-plugin",
      cwd: "/tmp",
      otherLivePluginPaths: [],
      expandMembers: async (abs) => [abs],
    });
    expect(unique.pluginPaths).toEqual([]);
    expect(unique.keptSharedRoot).toBe(false);

    const market = "/tmp/market";
    const a = join(market, "plugins", "a");
    const b = join(market, "plugins", "b");
    const shared = await nextPluginPathsAfterRemove({
      pluginPaths: [market, "/tmp/other"],
      pluginPath: a,
      cwd: "/tmp",
      otherLivePluginPaths: [b],
      expandMembers: async (abs) => (abs === market ? [a, b] : [abs]),
    });
    expect(shared.pluginPaths).toEqual([market, "/tmp/other"]);
    expect(shared.keptSharedRoot).toBe(true);
  });
});
