import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { GlobalSettingsWriter } from "../../src/mcp/add-server.js";
import type { ProjectTrustStore } from "../../src/trust/project-trust.js";
import { withMockedModule } from "../../testkit/mock-module.js";
import {
  dedupePluginModules,
  discoverUserPlugins,
  expandPluginPath,
  loadPluginsFromPaths,
  type ExpandPluginPathSkip,
} from "../plugins/loader.js";
import { defined } from "../../testkit/defined.js";
import {
  isPathPluginTrusted,
  loadPathTrust,
  revokePathPlugin,
  trustPathPlugin,
  trustPathPlugins,
} from "./path-trust.js";
import {
  isPluginTrusted,
  loadProjectTrust,
  trustPlugin,
} from "./project-trust.js";

// `onSkip` is required on `expandPluginPath` — no default sink to fall back
// to. These fixtures expect every declared member to resolve, so a skip here
// is a test-fixture bug; fail loudly instead of silently passing it through.
function failOnSkip(skip: ExpandPluginPathSkip): never {
  throw new Error(`unexpected marketplace skip: ${JSON.stringify(skip)}`);
}

async function writeCommandPlugin(
  dir: string,
  id: string,
  marker?: string,
): Promise<void> {
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
export const commandPlugin = { commands: [{ name: "ping", description: "ping", run: async () => undefined }] };
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
      expect(
        isPluginTrusted(await loadProjectTrust(cwdA, home), pluginDir),
      ).toBe(false);
      expect(
        isPluginTrusted(await loadProjectTrust(cwdB, home), pluginDir),
      ).toBe(false);

      const isTrusted = (p: string) => isPathPluginTrusted(pathTrust, p);
      const modsA = await loadPluginsFromPaths([pluginDir], cwdA, {
        isPluginTrusted: isTrusted,
      });
      const modsB = await loadPluginsFromPaths([pluginDir], cwdB, {
        isPluginTrusted: isTrusted,
      });
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
      expect(
        isPluginTrusted(await loadProjectTrust(cwd, home), pluginDir),
      ).toBe(true);

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
      expect(
        loadedA.find((m) => m.manifest?.id === "local")?.metadataOnly,
      ).toBeUndefined();
      expect(
        loadedB.find((m) => m.manifest?.id === "local")?.metadataOnly,
      ).toBe(true);
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

      const members = await expandPluginPath(root, { onSkip: failOnSkip });
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

      const members = await expandPluginPath(root, { onSkip: failOnSkip });
      expect(members).toEqual([sibling]);
      await trustPathPlugins(members, home);
      const pathTrust = await loadPathTrust(home);
      expect(isPathPluginTrusted(pathTrust, sibling)).toBe(true);
      const mods = await loadPluginsFromPaths([root], base, {
        isPluginTrusted: (p) => isPathPluginTrusted(pathTrust, p),
      });
      expect(mods.map((m) => m.manifest?.id)).toEqual(["gamma"]);
      const mod = defined(mods[0], "plugin module");
      expect(mod.metadataOnly).toBeUndefined();
      expect(mod.pluginPath).toBe(sibling);
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

// The /plugins add-by-path ordering probe (CL-8991): `trustPathPlugins` is
// mocked once for this file so each `addPath` below can observe whether any
// plugin code ran before the grant resolved. The wrapper delegates to the
// real store with an explicit home, so behavior — including the existing
// tests above, which always pass their own home — is unchanged.
const addPathProbe = {
  home: "",
  marker: "",
  trustCalls: [] as string[][],
  markerAtTrust: [] as boolean[],
};

function resetAddPathProbe(home: string, marker: string): void {
  addPathProbe.home = home;
  addPathProbe.marker = marker;
  addPathProbe.trustCalls = [];
  addPathProbe.markerAtTrust = [];
}

await withMockedModule(
  import.meta.resolve("../../src/trust/path-trust.js"),
  (real: typeof import("../../src/trust/path-trust.js")) => ({
    ...real,
    trustPathPlugins: async (paths: string[], home?: string) => {
      addPathProbe.trustCalls.push([...paths]);
      addPathProbe.markerAtTrust.push(
        await Bun.file(addPathProbe.marker).exists(),
      );
      return real.trustPathPlugins(paths, home ?? addPathProbe.home);
    },
    // revokeTrust in the backend calls without a home (production default).
    // Redirect here too so an add→revoke round trip in this file reads back
    // the same store the grant went to.
    revokePathPlugin: async (path: string, home?: string) => {
      return real.revokePathPlugin(path, home ?? addPathProbe.home);
    },
  }),
);

function stubSettingsWriter(): GlobalSettingsWriter {
  return {
    enqueue: async <T>(job: () => Promise<T>): Promise<T> => job(),
    update: async () => null,
    updateAt: async () => null,
    mutate: async () => "ok" as const,
    mutateAt: async () => "ok" as const,
  };
}

async function makeAddPathAdmin(base: string): Promise<{
  addPath: (
    path: string,
  ) => Promise<{ ok: boolean; message: string; id?: string }>;
  revokeTrust: (id: string) => Promise<{ ok: boolean; message: string }>;
}> {
  const backend = await import("../../src/tui/plugins-admin-backend.js");
  const emptyProjectTrust: ProjectTrustStore = {
    trustedPluginPaths: [],
    trustedMcpFingerprints: [],
    trustedGrantFingerprints: [],
  };
  const state = backend.createPluginsAdminState({
    cwd: base,
    settings: undefined,
    modules: [],
    pathTrust: { trustedPluginPaths: [] },
    projectTrust: emptyProjectTrust,
  });
  return backend.createPluginsAdmin({
    state,
    globalSettingsPath: join(base, "settings.json"),
    globalSettingsWriter: stubSettingsWriter(),
    noteWarnings: () => undefined,
  });
}

describe("addPath grants path trust before importing plugin code", () => {
  test("single plugin: no JS runs before trustPathPlugins resolves", async () => {
    const base = await mkdtemp(join(tmpdir(), "corbits-addpath-order-"));
    try {
      const home = join(base, "home");
      await mkdir(home, { recursive: true });
      const pluginDir = join(base, "shared-plugin");
      const marker = join(base, "RCE_MARKER");
      await writeCommandPlugin(pluginDir, "shared-plugin", marker);
      resetAddPathProbe(home, marker);

      const admin = await makeAddPathAdmin(base);
      const result = await admin.addPath("shared-plugin");
      expect(result).toEqual({
        ok: true,
        message: "Added shared-plugin",
        id: "shared-plugin",
      });

      expect(addPathProbe.trustCalls).toEqual([[pluginDir]]);
      for (const p of addPathProbe.trustCalls.flat())
        expect(isAbsolute(p)).toBe(true);
      expect(addPathProbe.markerAtTrust).toEqual([false]);
      expect(await Bun.file(marker).exists()).toBe(true);
      expect((await loadPathTrust(home)).trustedPluginPaths).toEqual([
        pluginDir,
      ]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("marketplace root: trust covers expanded members, still before any import", async () => {
    const base = await mkdtemp(join(tmpdir(), "corbits-addpath-mkt-"));
    try {
      const home = join(base, "home");
      await mkdir(home, { recursive: true });
      const root = join(base, "marketplace");
      const marker = join(base, "ROOT_MARKER");
      await writeCommandPlugin(root, "mkt-root", marker);
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
      resetAddPathProbe(home, marker);

      const admin = await makeAddPathAdmin(base);
      const result = await admin.addPath("marketplace");
      expect(result).toEqual({
        ok: true,
        message: `Added mkt-root (trusted 2 marketplace members: ${alpha}, ${beta})`,
        id: "mkt-root",
      });

      expect(addPathProbe.trustCalls).toEqual([[alpha, beta]]);
      for (const p of addPathProbe.trustCalls.flat())
        expect(isAbsolute(p)).toBe(true);
      expect(addPathProbe.markerAtTrust).toEqual([false]);
      expect(await Bun.file(marker).exists()).toBe(true);
      expect((await loadPathTrust(home)).trustedPluginPaths).toEqual([
        alpha,
        beta,
      ]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("bogus path grants nothing", async () => {
    const base = await mkdtemp(join(tmpdir(), "corbits-addpath-bogus-"));
    try {
      const home = join(base, "home");
      await mkdir(home, { recursive: true });
      resetAddPathProbe(home, join(base, "NEVER"));

      const admin = await makeAddPathAdmin(base);
      const result = await admin.addPath("does-not-exist");
      expect(result).toEqual({
        ok: false,
        message: "Could not load a plugin at does-not-exist",
      });
      expect(addPathProbe.trustCalls).toEqual([]);
      expect((await loadPathTrust(home)).trustedPluginPaths).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("post-trust import failure reports the load error and keeps the grant", async () => {
    const base = await mkdtemp(join(tmpdir(), "corbits-addpath-broken-"));
    try {
      const home = join(base, "home");
      await mkdir(home, { recursive: true });
      const pluginDir = join(base, "broken-plugin");
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, "manifest.json"),
        JSON.stringify({
          id: "broken-plugin",
          name: "broken-plugin",
          kind: "command",
        }),
        "utf8",
      );
      await writeFile(
        join(pluginDir, "index.ts"),
        `throw new Error("boom");\n`,
        "utf8",
      );
      resetAddPathProbe(home, join(base, "NEVER"));

      const admin = await makeAddPathAdmin(base);
      const result = await admin.addPath("broken-plugin");
      // Explicit add-by-path is consent: the grant is recorded before the
      // import runs, so a failed import keeps the grant. Only bogus
      // (unresolvable) paths return before the grant.
      expect(result).toEqual({
        ok: false,
        message: "Could not load a plugin at broken-plugin",
      });
      expect(addPathProbe.trustCalls).toEqual([[pluginDir]]);
      expect((await loadPathTrust(home)).trustedPluginPaths).toEqual([
        pluginDir,
      ]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("file-path add grants the containing dir so revokeTrust clears it and reload stays metadata-only", async () => {
    const base = await mkdtemp(join(tmpdir(), "corbits-addpath-file-"));
    try {
      const home = join(base, "home");
      await mkdir(home, { recursive: true });
      const pluginDir = join(base, "p");
      const marker = join(base, "FILE_MARKER");
      await writeCommandPlugin(pluginDir, "file-plugin", marker);
      resetAddPathProbe(home, marker);

      const admin = await makeAddPathAdmin(base);
      // Operator points at the file, not the directory.
      const result = await admin.addPath(join(pluginDir, "index.ts"));
      expect(result).toEqual({
        ok: true,
        message: "Added file-plugin",
        id: "file-plugin",
      });
      // The grant is the normalized dir — the identity loadPluginEntry stamps
      // and revokeTrust removes — never the raw file path.
      expect(addPathProbe.trustCalls).toEqual([[pluginDir]]);
      expect((await loadPathTrust(home)).trustedPluginPaths).toEqual([
        pluginDir,
      ]);
      expect(await Bun.file(marker).exists()).toBe(true);

      const revoked = await admin.revokeTrust("file-plugin");
      expect(revoked.ok).toBe(true);
      expect((await loadPathTrust(home)).trustedPluginPaths).toEqual([]);

      // Next boot resolves the persisted entry against the emptied store: the
      // module stays metadata-only and its code never re-executes.
      await rm(marker, { force: true });
      const store = await loadPathTrust(home);
      const mods = await loadPluginsFromPaths([pluginDir], base, {
        isPluginTrusted: (p) => isPathPluginTrusted(store, p),
      });
      expect(
        mods.find((m) => m.manifest?.id === "file-plugin")?.metadataOnly,
      ).toBe(true);
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("hybrid root add surfaces exactly the expanded member set", async () => {
    const base = await mkdtemp(join(tmpdir(), "corbits-addpath-hybrid-"));
    try {
      const home = join(base, "home");
      await mkdir(home, { recursive: true });
      const root = join(base, "hybrid");
      const rootMarker = join(base, "ROOT_MARKER");
      await writeCommandPlugin(root, "hybrid-root", rootMarker);
      const sibling = join(base, "agents", "evil-sibling");
      const siblingMarker = join(base, "SIBLING_MARKER");
      await writeCommandPlugin(sibling, "evil-sibling", siblingMarker);
      await mkdir(join(root, ".claude-plugin"), { recursive: true });
      await writeFile(
        join(root, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          plugins: [{ name: "evil-sibling", source: "../agents/evil-sibling" }],
        }),
        "utf8",
      );
      resetAddPathProbe(home, rootMarker);

      const admin = await makeAddPathAdmin(base);
      const result = await admin.addPath("hybrid");
      // Only the expanded member set is granted, and the result names it so
      // the operator sees the sibling consent covers.
      expect(addPathProbe.trustCalls).toEqual([[sibling]]);
      expect((await loadPathTrust(home)).trustedPluginPaths).toEqual([sibling]);
      expect(result).toEqual({
        ok: true,
        message: `Added hybrid-root (trusted 1 marketplace member: ${sibling})`,
        id: "hybrid-root",
      });
      // The sibling is granted but never imported by the add itself.
      expect(await Bun.file(siblingMarker).exists()).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
