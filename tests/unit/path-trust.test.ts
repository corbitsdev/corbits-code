import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isPathPluginTrusted,
  loadPathTrust,
  migratePathTrustFromPluginPaths,
  pathTrustPath,
  pathTrustStoreExists,
  trustPathPlugin,
  trustPathPlugins,
} from "../../src/trust/path-trust.js";

async function scratch(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), "corbits-path-trust-"));
  await mkdir(home, { recursive: true });
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

describe("path-trust (global)", () => {
  test("store lives under home trust dir with a fixed name", async () => {
    const { home, cleanup } = await scratch();
    try {
      const path = pathTrustPath(home);
      expect(path).toBe(join(home, ".corbits", "trust", "path-plugins.json"));
    } finally {
      await cleanup();
    }
  });

  test("trustPathPlugin persists absolute path independent of cwd", async () => {
    const { home, cleanup } = await scratch();
    try {
      const pluginPath = join(home, "plugins", "my-plugin");
      const store = await trustPathPlugin(pluginPath, home);
      expect(isPathPluginTrusted(store, pluginPath)).toBe(true);
      const reloaded = await loadPathTrust(home);
      expect(isPathPluginTrusted(reloaded, pluginPath)).toBe(true);
      const raw = await readFile(pathTrustPath(home), "utf8");
      expect(raw).toContain(pluginPath);
    } finally {
      await cleanup();
    }
  });

  test("trustPathPlugins grants multiple members in one write", async () => {
    const { home, cleanup } = await scratch();
    try {
      const a = join(home, "plugins", "a");
      const b = join(home, "plugins", "b");
      const store = await trustPathPlugins([a, b], home);
      expect(isPathPluginTrusted(store, a)).toBe(true);
      expect(isPathPluginTrusted(store, b)).toBe(true);
      // Idempotent second call.
      const again = await trustPathPlugins([a], home);
      expect(again.trustedPluginPaths).toEqual(store.trustedPluginPaths);
    } finally {
      await cleanup();
    }
  });

  test("path trust is not keyed by working directory", async () => {
    const { home, cleanup } = await scratch();
    try {
      const pluginPath = "/opt/shared/plugin";
      await trustPathPlugin(pluginPath, home);
      // Same home store is visible regardless of which repo cwd we pretend to use.
      const store = await loadPathTrust(home);
      expect(isPathPluginTrusted(store, pluginPath)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("migratePathTrustFromPluginPaths seeds only when store file is missing", async () => {
    const { home, cleanup } = await scratch();
    try {
      const plugin = join(home, "shared", "plugin");
      expect(await pathTrustStoreExists(home)).toBe(false);

      const first = await migratePathTrustFromPluginPaths(
        [plugin],
        async () => [plugin],
        home,
      );
      expect(isPathPluginTrusted(first, plugin)).toBe(true);
      expect(await pathTrustStoreExists(home)).toBe(true);

      // Second boot with extra path must NOT auto-grant the newcomer.
      const extra = join(home, "shared", "newcomer");
      const second = await migratePathTrustFromPluginPaths(
        [plugin, extra],
        async (p) => [p],
        home,
      );
      expect(isPathPluginTrusted(second, plugin)).toBe(true);
      expect(isPathPluginTrusted(second, extra)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("migrate with empty pluginPaths does not create the store file", async () => {
    const { home, cleanup } = await scratch();
    try {
      const store = await migratePathTrustFromPluginPaths([], async () => [], home);
      expect(store.trustedPluginPaths).toEqual([]);
      expect(await pathTrustStoreExists(home)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("migrate with only missing members writes an empty store once", async () => {
    const { home, cleanup } = await scratch();
    try {
      const missing = join(home, "gone", "plugin");
      const store = await migratePathTrustFromPluginPaths(
        [missing],
        async () => [], // resolveMembers drops missing
        home,
      );
      expect(store.trustedPluginPaths).toEqual([]);
      expect(await pathTrustStoreExists(home)).toBe(true);
      // Second pass must not re-invoke resolveMembers into a grant.
      let resolveCalls = 0;
      await migratePathTrustFromPluginPaths(
        [missing],
        async () => {
          resolveCalls += 1;
          return [missing];
        },
        home,
      );
      expect(resolveCalls).toBe(0);
    } finally {
      await cleanup();
    }
  });
});
