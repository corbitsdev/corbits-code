import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dedupePluginModules,
  discoverUserPlugins,
  expandPluginPath,
  loadPluginsFromPaths,
} from "../../src/plugins/loader.js";
import {
  isPathPluginTrusted,
  loadPathTrust,
  revokePathPlugin,
  trustPathPlugin,
  trustPathPlugins,
} from "../../src/trust/path-trust.js";
import { isPluginTrusted, loadProjectTrust, trustPlugin } from "../../src/trust/project-trust.js";

async function writeCommandPlugin(dir: string, id: string, marker?: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({ id, name: id, kind: "command" }),
    "utf8",
  );
  const sideEffect =
    marker !== undefined
      ? `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "pwned");\n`
      : "";
  await writeFile(
    join(dir, "index.ts"),
    `${sideEffect}export const manifest = { id: ${JSON.stringify(id)}, name: ${JSON.stringify(id)}, kind: "command" };
export const commandPlugin = { commands: [{ name: "ping", description: "ping", run: async () => {} }] };
`,
    "utf8",
  );
}

describe("path plugin trust across working directories", () => {
  test("untrusted path plugin is metadata-only and does not import code", async () => {
    const base = await mkdtemp(join(tmpdir(), "corbits-path-plugin-"));
    try {
      const pluginDir = join(base, "shared-plugin");
      const marker = join(base, "RCE_MARKER");
      await writeCommandPlugin(pluginDir, "shared-plugin", marker);

      const mods = await loadPluginsFromPaths([pluginDir], base, {
        isPluginTrusted: () => false,
      });
      const mod = mods.find((m) => m.manifest?.id === "shared-plugin");
      expect(mod).toBeDefined();
      expect(mod?.metadataOnly).toBe(true);
      expect(mod?.commandPlugin).toBeUndefined();
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("path trusted globally fully loads in a second cwd without project trust", async () => {
    const base = await mkdtemp(join(tmpdir(), "corbits-path-cross-cwd-"));
    const home = join(base, "home");
    const pluginDir = join(base, "shared-plugin");
    const cwdA = join(base, "repo-a");
    const cwdB = join(base, "repo-b");
    try {
      await mkdir(home, { recursive: true });
      await mkdir(cwdA, { recursive: true });
      await mkdir(cwdB, { recursive: true });
      await writeCommandPlugin(pluginDir, "shared-plugin");

      // Grant only global path trust — no project trust in either cwd.
      await trustPathPlugin(pluginDir, home);
      const pathTrust = await loadPathTrust(home);
      expect(isPathPluginTrusted(pathTrust, pluginDir)).toBe(true);
      expect(isPluginTrusted(await loadProjectTrust(cwdA, home), pluginDir)).toBe(false);
      expect(isPluginTrusted(await loadProjectTrust(cwdB, home), pluginDir)).toBe(false);

      const isTrusted = (p: string) => isPathPluginTrusted(pathTrust, p);
      const modsA = await loadPluginsFromPaths([pluginDir], cwdA, { isPluginTrusted: isTrusted });
      const modsB = await loadPluginsFromPaths([pluginDir], cwdB, { isPluginTrusted: isTrusted });
      for (const mods of [modsA, modsB]) {
        const mod = mods.find((m) => m.manifest?.id === "shared-plugin");
        expect(mod?.metadataOnly).toBeUndefined();
        expect(mod?.commandPlugin).toBeDefined();
        expect(mod?.origin).toBe("path");
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("project trust for a path does not satisfy path-origin load (stores stay separate)", async () => {
    const base = await mkdtemp(join(tmpdir(), "corbits-path-no-or-"));
    const home = join(base, "home");
    const pluginDir = join(base, "shared-plugin");
    const cwd = join(base, "repo");
    try {
      await mkdir(home, { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeCommandPlugin(pluginDir, "shared-plugin");

      // Only project trust — path origin must still refuse full load.
      await trustPlugin(cwd, pluginDir, home);
      expect(isPluginTrusted(await loadProjectTrust(cwd, home), pluginDir)).toBe(true);

      const pathTrust = await loadPathTrust(home);
      const mods = await loadPluginsFromPaths([pluginDir], cwd, {
        isPluginTrusted: (p) => isPathPluginTrusted(pathTrust, p),
      });
      const mod = mods.find((m) => m.manifest?.id === "shared-plugin");
      expect(mod?.metadataOnly).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("project plugin still requires per-cwd trust after path trust exists", async () => {
    const base = await mkdtemp(join(tmpdir(), "corbits-project-still-"));
    const home = join(base, "home");
    const cwdA = join(base, "repo-a");
    const cwdB = join(base, "repo-b");
    try {
      await mkdir(home, { recursive: true });
      const pluginA = join(cwdA, ".corbits", "plugins", "local");
      const pluginB = join(cwdB, ".corbits", "plugins", "local");
      await writeCommandPlugin(pluginA, "local");
      await writeCommandPlugin(pluginB, "local");

      await trustPlugin(cwdA, pluginA, home);
      // Unrelated path trust must not open project plugins.
      await trustPathPlugin(join(base, "unrelated"), home);

      const trustA = await loadProjectTrust(cwdA, home);
      const trustB = await loadProjectTrust(cwdB, home);
      const loadedA = await discoverUserPlugins(cwdA, {
        isPluginTrusted: (p) => isPluginTrusted(trustA, p),
      });
      const loadedB = await discoverUserPlugins(cwdB, {
        isPluginTrusted: (p) => isPluginTrusted(trustB, p),
      });
      expect(loadedA.find((m) => m.manifest?.id === "local")?.metadataOnly).toBeUndefined();
      expect(loadedB.find((m) => m.manifest?.id === "local")?.metadataOnly).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a pluginPaths entry inside <cwd>/.corbits/plugins stays project origin", async () => {
    const base = await mkdtemp(join(tmpdir(), "corbits-dual-origin-"));
    const home = join(base, "home");
    const cwd = join(base, "repo");
    try {
      await mkdir(home, { recursive: true });
      const pluginDir = join(cwd, ".corbits", "plugins", "dual");
      await writeCommandPlugin(pluginDir, "dual");
      await trustPlugin(cwd, pluginDir, home);
      const projectTrust = await loadProjectTrust(cwd, home);

      // Same discovery order as the runners: project scan first, explicit
      // paths last. The path store has no grant for this plugin.
      const fromPaths = await loadPluginsFromPaths([pluginDir], cwd, {
        isPluginTrusted: () => false,
      });
      expect(fromPaths).toEqual([]);

      const mods = dedupePluginModules([
        ...(await discoverUserPlugins(cwd, {
          isPluginTrusted: (p) => isPluginTrusted(projectTrust, p),
        })),
        ...fromPaths,
      ]);
      const mod = mods.find((m) => m.manifest?.id === "dual");
      expect(mod?.origin).toBe("project");
      expect(mod?.metadataOnly).toBeUndefined();
      expect(mod?.commandPlugin).toBeDefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("marketplace root expand trusts each member via trustPathPlugins", async () => {
    const base = await mkdtemp(join(tmpdir(), "corbits-mkt-path-"));
    const home = join(base, "home");
    try {
      await mkdir(home, { recursive: true });
      const root = join(base, "marketplace");
      const alpha = join(root, "plugins", "alpha");
      const beta = join(root, "plugins", "beta");
      await writeCommandPlugin(alpha, "alpha");
      await writeCommandPlugin(beta, "beta");
      await mkdir(join(root, ".claude-plugin"), { recursive: true });
      await writeFile(
        join(root, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          plugins: [
            { name: "alpha", source: "./plugins/alpha" },
            { name: "beta", source: "./plugins/beta" },
          ],
        }),
        "utf8",
      );

      const members = await expandPluginPath(root);
      expect(members).toEqual([alpha, beta]);
      await trustPathPlugins(members, home);
      const pathTrust = await loadPathTrust(home);
      const mods = await loadPluginsFromPaths([root], base, {
        isPluginTrusted: (p) => isPathPluginTrusted(pathTrust, p),
      });
      expect(mods.map((m) => m.manifest?.id).sort()).toEqual(["alpha", "beta"]);
      for (const m of mods) {
        expect(m.metadataOnly).toBeUndefined();
        expect(m.commandPlugin).toBeDefined();
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("marketplace sibling ../agents member is trusted at its resolved path", async () => {
    const base = await mkdtemp(join(tmpdir(), "corbits-mkt-sibling-"));
    const home = join(base, "home");
    try {
      await mkdir(home, { recursive: true });
      const root = join(base, "marketplace");
      const sibling = join(base, "agents", "gamma");
      await writeCommandPlugin(sibling, "gamma");
      await mkdir(join(root, ".claude-plugin"), { recursive: true });
      await writeFile(
        join(root, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          plugins: [{ name: "gamma", source: "../agents/gamma" }],
        }),
        "utf8",
      );

      const members = await expandPluginPath(root);
      expect(members).toEqual([sibling]);
      await trustPathPlugins(members, home);
      const pathTrust = await loadPathTrust(home);
      expect(isPathPluginTrusted(pathTrust, sibling)).toBe(true);
      const mods = await loadPluginsFromPaths([root], base, {
        isPluginTrusted: (p) => isPathPluginTrusted(pathTrust, p),
      });
      expect(mods.map((m) => m.manifest?.id)).toEqual(["gamma"]);
      expect(mods[0]!.metadataOnly).toBeUndefined();
      expect(mods[0]!.pluginPath).toBe(sibling);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("revoked grant no longer loads code on subsequent discovery", async () => {
    const base = await mkdtemp(join(tmpdir(), "corbits-revoke-load-"));
    const home = join(base, "home");
    try {
      await mkdir(home, { recursive: true });
      const plugin = join(base, "p");
      const marker = join(base, "MARKER2");
      await writeCommandPlugin(plugin, "p", marker);
      await trustPathPlugin(plugin, home);
      await revokePathPlugin(plugin, home);
      const store = await loadPathTrust(home);
      const mods = await loadPluginsFromPaths([plugin], base, {
        isPluginTrusted: (p) => isPathPluginTrusted(store, p),
      });
      expect(mods.find((m) => m.manifest?.id === "p")?.metadataOnly).toBe(true);
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
