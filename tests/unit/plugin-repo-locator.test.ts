import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { discoverRepoPlugins, resolveRepoPluginsDir } from "../../src/plugins/loader.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "corbits-repo-plugins-"));
  tmpDirs.push(dir);
  return dir;
}

async function writeLoadablePlugin(pluginDir: string, id: string): Promise<void> {
  await mkdir(join(pluginDir, "commands"), { recursive: true });
  await writeFile(
    join(pluginDir, "manifest.json"),
    JSON.stringify({ id, name: id, kind: "command", defaultEnabled: true }),
    "utf8",
  );
  await writeFile(
    join(pluginDir, "commands", "hello.md"),
    "---\ndescription: hello\n---\nHello.\n",
    "utf8",
  );
}

describe("resolveRepoPluginsDir", () => {
  test("does not use session cwd/plugins", async () => {
    const root = await tmpRoot();
    await mkdir(join(root, "cwd", "plugins", "foreign"), { recursive: true });
    const resolved = resolveRepoPluginsDir({
      moduleUrl: pathToFileURL(join(root, "src", "plugins", "loader.ts")).href,
      execPath: join(root, "no-such-bin", "corbits"),
    });
    expect(resolved).toBeUndefined();
  });

  test("prefers the first existing candidate (source tree over execPath)", async () => {
    const root = await tmpRoot();
    await mkdir(join(root, "plugins"), { recursive: true });
    await mkdir(join(root, "bin", "plugins"), { recursive: true });
    const resolved = resolveRepoPluginsDir({
      moduleUrl: pathToFileURL(join(root, "src", "plugins", "loader.ts")).href,
      execPath: join(root, "bin", "corbits"),
    });
    expect(resolved).toBe(join(root, "plugins"));
  });

  test("uses dist/plugins when the module is the bundled index", async () => {
    const root = await tmpRoot();
    await mkdir(join(root, "dist", "plugins"), { recursive: true });
    const resolved = resolveRepoPluginsDir({
      moduleUrl: pathToFileURL(join(root, "dist", "index.js")).href,
      execPath: join(root, "no-such-bin", "corbits"),
    });
    expect(resolved).toBe(join(root, "dist", "plugins"));
  });

  test("from dist/index.js prefers dist/plugins over ancestor ../../plugins", async () => {
    const root = await tmpRoot();
    const tmp = join(root, "app");
    const ancestor = join(root, "plugins");
    const distPlugins = join(tmp, "dist", "plugins");
    await mkdir(ancestor, { recursive: true });
    await mkdir(distPlugins, { recursive: true });
    const resolved = resolveRepoPluginsDir({
      moduleUrl: pathToFileURL(join(tmp, "dist", "index.js")).href,
      execPath: join(root, "no-such-bin", "corbits"),
    });
    expect(resolved).toBe(distPlugins);
    expect(resolved).not.toBe(ancestor);
  });

  test("from dist/index.js does not pick ancestor ../../plugins when dist/plugins is missing", async () => {
    const root = await tmpRoot();
    const tmp = join(root, "app");
    const ancestor = join(root, "plugins");
    const binPlugins = join(root, "bin", "plugins");
    await mkdir(ancestor, { recursive: true });
    await mkdir(join(tmp, "dist"), { recursive: true });
    await mkdir(binPlugins, { recursive: true });
    const withoutExec = resolveRepoPluginsDir({
      moduleUrl: pathToFileURL(join(tmp, "dist", "index.js")).href,
      execPath: join(root, "no-such-bin", "corbits"),
    });
    expect(withoutExec).toBeUndefined();
    const withExec = resolveRepoPluginsDir({
      moduleUrl: pathToFileURL(join(tmp, "dist", "index.js")).href,
      execPath: join(root, "bin", "corbits"),
    });
    expect(withExec).toBe(binPlugins);
  });

  test("uses injectable execPath when source and bundle candidates are missing", async () => {
    const root = await tmpRoot();
    const plugins = join(root, "bin", "plugins");
    await mkdir(plugins, { recursive: true });
    const resolved = resolveRepoPluginsDir({
      moduleUrl: pathToFileURL(join(root, "src", "plugins", "loader.ts")).href,
      execPath: join(root, "bin", "corbits"),
    });
    expect(resolved).toBe(plugins);
  });
});

describe("discoverRepoPlugins", () => {
  test("loads from the locator dir, not cwd/plugins", async () => {
    const root = await tmpRoot();
    const cwd = join(root, "cwd");
    await writeLoadablePlugin(join(root, "plugins", "shipped"), "shipped");
    await writeLoadablePlugin(join(cwd, "plugins", "foreign"), "foreign");
    const mods = await discoverRepoPlugins(cwd, {
      moduleUrl: pathToFileURL(join(root, "src", "plugins", "loader.ts")).href,
      execPath: join(root, "no-such-bin", "corbits"),
    });
    expect(mods.map((m) => m.manifest?.id)).toEqual(["shipped"]);
    expect(mods[0]?.origin).toBe("repo");
  });

  test("returns empty when no locator candidate exists, even if cwd has plugins", async () => {
    const root = await tmpRoot();
    const cwd = join(root, "cwd");
    await writeLoadablePlugin(join(cwd, "plugins", "foreign"), "foreign");
    const mods = await discoverRepoPlugins(cwd, {
      moduleUrl: pathToFileURL(join(root, "src", "plugins", "loader.ts")).href,
      execPath: join(root, "no-such-bin", "corbits"),
    });
    expect(mods).toEqual([]);
  });

  test("discovers via injectable execPath", async () => {
    const root = await tmpRoot();
    const cwd = join(root, "session");
    await mkdir(cwd, { recursive: true });
    await writeLoadablePlugin(join(root, "bin", "plugins", "from-bin"), "from-bin");
    const mods = await discoverRepoPlugins(cwd, {
      moduleUrl: pathToFileURL(join(root, "src", "plugins", "loader.ts")).href,
      execPath: join(root, "bin", "corbits"),
    });
    expect(mods.map((m) => m.manifest?.id)).toEqual(["from-bin"]);
    expect(mods[0]?.origin).toBe("repo");
  });
});
