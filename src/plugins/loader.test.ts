import { defined } from "../../testkit/defined.js";
import { describe, test, expect } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginLoadDiagnostics } from "./diagnostics.js";
import {
  dedupePluginModules,
  loadPluginEntry,
  loadPluginsFromPaths,
  type PluginModule,
} from "./loader.js";
import { isPluginModuleEnabled } from "./register.js";
import { disablePluginSettings } from "./uninstall.js";
import { parsePluginManifest } from "./manifest.js";

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

  // A later non-repo install with a repo defaultEnabled id must not
  // silently turn the bundled default off.
  test("stamps shadowedRepoDefaultEnabled when a non-repo module shadows a repo defaultEnabled id", () => {
    const repo = repoDefaultEnabled("scout");
    const user = userInstall("scout");
    const [result] = dedupePluginModules([repo, user]);
    expect(defined(result).shadowedRepoDefaultEnabled).toBe(true);
  });

  test("does not stamp shadowedRepoDefaultEnabled when the repo module wasn't defaultEnabled", () => {
    const repo: PluginModule = {
      manifest: { id: "scout", name: "scout", kind: "agent" },
      origin: "repo",
    };
    const user = userInstall("scout");
    const [result] = dedupePluginModules([repo, user]);
    expect(defined(result).shadowedRepoDefaultEnabled).toBeUndefined();
  });

  test("does not stamp unrelated ids", () => {
    const repo = repoDefaultEnabled("scout");
    const other = userInstall("other");
    const result = dedupePluginModules([repo, other]);
    expect(
      defined(result.find((m) => m.manifest?.id === "other"))
        .shadowedRepoDefaultEnabled,
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
    expect(defined(result).shadowedRepoDefaultEnabled).toBe(true);
  });
});

describe("isPluginModuleEnabled with dedupe shadowing", () => {
  test("a same-id later install stays enabled by default after shadowing a repo defaultEnabled plugin", () => {
    const repo = repoDefaultEnabled("scout");
    const user = userInstall("scout");
    const [survivor] = dedupePluginModules([repo, user]);
    expect(isPluginModuleEnabled(defined(survivor), {})).toBe(true);
  });

  test("an explicit disable in settings still wins over the preserved default-on", () => {
    const repo = repoDefaultEnabled("scout");
    const user = userInstall("scout");
    const [survivor] = dedupePluginModules([repo, user]);
    expect(
      isPluginModuleEnabled(defined(survivor), { scout: { enabled: false } }),
    ).toBe(false);
  });

  test("disablePluginSettings then isPluginModuleEnabled is false for shadowedRepoDefaultEnabled", () => {
    const repo = repoDefaultEnabled("scout");
    const user = userInstall("scout");
    const [survivor] = dedupePluginModules([repo, user]);
    expect(defined(survivor).shadowedRepoDefaultEnabled).toBe(true);
    const plugins = disablePluginSettings({}, "scout");
    expect(plugins.scout?.enabled).toBe(false);
    expect(isPluginModuleEnabled(defined(survivor), plugins)).toBe(false);
  });

  test("without dedupe shadowing, a plain user-origin module needs an explicit enable", () => {
    const user = userInstall("scout");
    expect(isPluginModuleEnabled(user, {})).toBe(false);
  });
});

async function makeJsPlugin(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "manifest-plugin-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body);
  }
  return dir;
}

describe("readManifestJson malformed vs missing", () => {
  test("malformed manifest.json warns with path and parse error", async () => {
    const dir = await makeJsPlugin({
      "index.js": "export {};\n",
      "manifest.json": "{not-json",
    });
    const warnings: string[] = [];
    await loadPluginEntry(dir, { onWarning: (msg) => warnings.push(msg) });
    const manifestPath = join(dir, "manifest.json");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes(manifestPath))).toBe(true);
  });

  test("invalid manifest.json schema warns with path and validation error", async () => {
    const dir = await makeJsPlugin({
      "index.js": "export {};\n",
      "manifest.json": JSON.stringify({ id: "x", name: "X" }),
    });
    const warnings: string[] = [];
    await loadPluginEntry(dir, { onWarning: (msg) => warnings.push(msg) });
    const manifestPath = join(dir, "manifest.json");
    expect(warnings.some((w) => w.includes(manifestPath))).toBe(true);
    expect(
      warnings.some((w) => w.includes(manifestPath) && w.includes("kind")),
    ).toBe(true);
  });

  test("missing manifest.json stays silent", async () => {
    const dir = await makeJsPlugin({
      "index.js": "export {};\n",
    });
    const warnings: string[] = [];
    await loadPluginEntry(dir, { onWarning: (msg) => warnings.push(msg) });
    expect(warnings).toEqual([]);
  });

  test("malformed .claude-plugin/manifest.json warns on metadata-only load", async () => {
    const dir = await makeJsPlugin({
      ".claude-plugin/manifest.json": "{not-json",
    });
    const diag = createPluginLoadDiagnostics();
    const cwd = await mkdtemp(join(tmpdir(), "manifest-cwd-"));
    const mods = await loadPluginsFromPaths([dir], cwd, {
      isPluginTrusted: () => false,
      diagnostics: diag,
    });
    expect(mods).toEqual([]);
    const manifestPath = join(dir, ".claude-plugin", "manifest.json");
    expect(diag.warnings.some((w) => w.includes(manifestPath))).toBe(true);
  });

  test("missing manifest on metadata-only load stays silent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "manifest-empty-"));
    const diag = createPluginLoadDiagnostics();
    const cwd = await mkdtemp(join(tmpdir(), "manifest-cwd-"));
    const mods = await loadPluginsFromPaths([dir], cwd, {
      isPluginTrusted: () => false,
      diagnostics: diag,
    });
    expect(mods).toEqual([]);
    expect(diag.warnings).toEqual([]);
  });

  test("malformed native manifest.json on data-only plugin warns and does not silently infer kind", async () => {
    const dir = await makeJsPlugin({
      "agents/a.md": "---\nname: a\n---\nbody\n",
      "manifest.json": "{not-json",
    });
    const warnings: string[] = [];
    const mod = await loadPluginEntry(dir, {
      onWarning: (msg) => warnings.push(msg),
    });
    expect(mod).not.toBeNull();
    expect(mod?.agentPlugin).toBeDefined();
  });

  test("Claude-format .claude-plugin/manifest.json does not warn missing id/kind on metadata-only load", async () => {
    const dir = await makeJsPlugin({
      ".claude-plugin/manifest.json": JSON.stringify({
        name: "cmo",
        description: "Marketing ops",
      }),
    });
    const diag = createPluginLoadDiagnostics();
    const cwd = await mkdtemp(join(tmpdir(), "manifest-cwd-"));
    const mods = await loadPluginsFromPaths([dir], cwd, {
      isPluginTrusted: () => false,
      diagnostics: diag,
    });
    expect(
      diag.warnings.some((w) => w.includes("invalid plugin manifest")),
    ).toBe(false);
    expect(
      diag.warnings.some(
        (w) =>
          w.includes(join(dir, ".claude-plugin", "manifest.json")) &&
          (w.includes("id") || w.includes("kind")),
      ),
    ).toBe(false);
    const mod = mods.find((m) => m.manifest?.id === "cmo");
    expect(mod?.metadataOnly).toBe(true);
    expect(mod?.manifest?.name).toBe("cmo");
    expect(mod?.manifest?.description).toBe("Marketing ops");
  });
});

describe("plugin path loading", () => {
  test("loadPluginEntry returns null for a non-existent path", async () => {
    expect(await loadPluginEntry("/no/such/plugin/here")).toBeNull();
  });

  test("loadPluginsFromPaths resolves relative paths against cwd and skips bad ones", async () => {
    const mods = await loadPluginsFromPaths(
      ["fixtures/plugins/exa", "does-not-exist"],
      process.cwd(),
    );
    expect(mods.map((m) => m.manifest?.id)).toEqual(["exa"]);
  });

  test("manifest requires a kind", () => {
    expect(
      parsePluginManifest({ id: "x", name: "X", kind: "web" }),
    ).not.toBeNull();
    expect(parsePluginManifest({ id: "x", name: "X" })).toBeNull();
    expect(
      parsePluginManifest({ id: "x", name: "X", kind: "bogus" }),
    ).toBeNull();
  });

  test("manifest parses optional defaultEnabled", () => {
    expect(
      parsePluginManifest({
        id: "x",
        name: "X",
        kind: "command",
        defaultEnabled: true,
      }),
    ).toEqual({
      id: "x",
      name: "X",
      kind: "command",
      defaultEnabled: true,
    });
    expect(
      parsePluginManifest({ id: "x", name: "X", kind: "command" })
        ?.defaultEnabled,
    ).toBeUndefined();
    expect(
      parsePluginManifest({
        id: "x",
        name: "X",
        kind: "command",
        defaultEnabled: "yes",
      }),
    ).toBeNull();
  });

  test("dedupePluginModules keeps the last module per id (path > user > repo)", () => {
    const repo: PluginModule = {
      manifest: { id: "dup", name: "Repo", kind: "command" },
      commandPlugin: { commands: [] },
    };
    const user: PluginModule = {
      manifest: { id: "dup", name: "User", kind: "command" },
      commandPlugin: { commands: [] },
    };
    const other: PluginModule = {
      manifest: { id: "other", name: "Other", kind: "web" },
    };
    const noManifest: PluginModule = { commandPlugin: { commands: [] } };
    const out = dedupePluginModules([repo, other, user, noManifest]);
    expect(out.find((m) => m.manifest?.id === "dup")?.manifest?.name).toBe(
      "User",
    );
    expect(out.filter((m) => m.manifest?.id === "dup").length).toBe(1);
    expect(out).toContain(noManifest); // kept (no id)
    expect(out.length).toBe(3);
  });

  test("loadPluginEntry maps a default export to the factory for the manifest kind", async () => {
    const toolMod = await loadPluginEntry("fixtures/plugins/example-tool");
    expect(toolMod?.manifest?.kind).toBe("tool");
    expect(typeof toolMod?.createToolPlugin).toBe("function");
    expect(toolMod?.createWebProvider).toBeUndefined();

    const webMod = await loadPluginEntry("fixtures/plugins/exa");
    expect(webMod?.manifest?.kind).toBe("web");
    expect(typeof webMod?.createWebProvider).toBe("function");
    expect(webMod?.createToolPlugin).toBeUndefined();
  });
});
