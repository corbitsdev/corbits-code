import { describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverClaudeInstalledPlugins } from "./loader.js";
import { resolveAgentPluginProfiles } from "./agent-plugins.js";

async function writeAgentPlugin(dir: string, id: string): Promise<void> {
  await mkdir(join(dir, "agents"), { recursive: true });
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ id, name: id, kind: "agent" }));
  await writeFile(
    join(dir, "agents", "scout.md"),
    [
      "---",
      "name: scout",
      "description: Fast explorer from Claude install",
      "---",
      "",
      "You map repositories quickly.",
      "",
    ].join("\n"),
  );
}

describe("discoverClaudeInstalledPlugins", () => {
  test("returns empty when registry is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-home-missing-"));
    const modules = await discoverClaudeInstalledPlugins("/repo", { home });
    expect(modules).toEqual([]);
  });

  test("loads installPath entries and stamps source claude", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-home-"));
    const installPath = join(home, ".claude", "plugins", "cache", "demo", "1.0.0");
    await writeAgentPlugin(installPath, "demo-agent");
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "demo@marketplace": [
            {
              scope: "user",
              installPath,
              version: "1.0.0",
            },
          ],
        },
      }),
    );

    const modules = await discoverClaudeInstalledPlugins("/repo", { home });
    expect(modules.length).toBe(1);
    expect(modules[0]!.source).toBe("claude");
    expect(modules[0]!.origin).toBe("user");
    expect(modules[0]!.manifest?.id).toBe("demo-agent");
    expect(modules[0]!.agentPlugin?.agents.length).toBeGreaterThan(0);

    // Enable-gate still applies: disabled config yields no profiles.
    expect(await resolveAgentPluginProfiles(modules, {})).toEqual([]);

    const enabled = await resolveAgentPluginProfiles(modules, {
      "demo-agent": { enabled: true },
    });
    expect(enabled.length).toBeGreaterThan(0);
    expect(enabled.every((p) => p.source === "claude")).toBe(true);
  });

  test("skips missing install paths without failing the batch", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-home-skip-"));
    const good = join(home, ".claude", "plugins", "cache", "good", "1.0.0");
    await writeAgentPlugin(good, "good-agent");
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "missing@x": [{ installPath: join(home, "does-not-exist") }],
          "good@x": [{ installPath: good }],
        },
      }),
    );

    const modules = await discoverClaudeInstalledPlugins("/repo", { home });
    expect(modules.map((m) => m.manifest?.id)).toEqual(["good-agent"]);
  });

  test("dedupes the same installPath listed twice", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-home-dedupe-"));
    const installPath = join(home, ".claude", "plugins", "cache", "once", "1.0.0");
    await writeAgentPlugin(installPath, "once-agent");
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "a@x": [{ installPath }],
          "b@x": [{ installPath }],
        },
      }),
    );

    const modules = await discoverClaudeInstalledPlugins("/repo", { home });
    expect(modules.length).toBe(1);
  });

  test("reads .claude-plugin/manifest.json when plugin.json is absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-home-manifest-json-"));
    const installPath = join(home, ".claude", "plugins", "cache", "mkt", "cmo", "1.0.0");
    await mkdir(join(installPath, ".claude-plugin"), { recursive: true });
    await mkdir(join(installPath, "agents"), { recursive: true });
    await writeFile(
      join(installPath, ".claude-plugin", "manifest.json"),
      JSON.stringify({ name: "cmo", description: "Marketing ops", version: "1.0.0" }),
    );
    await writeFile(
      join(installPath, "agents", "angle.md"),
      ["---", "description: Angle specialist", "---", "", "You generate angles.", ""].join("\n"),
    );
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "cmo@mkt": [{ installPath, version: "1.0.0" }] },
      }),
    );

    const modules = await discoverClaudeInstalledPlugins("/repo", { home });
    expect(modules.length).toBe(1);
    expect(modules[0]!.manifest?.id).toBe("cmo");
    expect(modules[0]!.source).toBe("claude");
  });

  test("rewrites version-dir basename ids using the registry key", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-home-version-id-"));
    // No manifest at all — data-only falls back to basename(installPath) = "1.0.0".
    const installPath = join(home, ".claude", "plugins", "cache", "mkt", "orphan", "1.0.0");
    await mkdir(join(installPath, "agents"), { recursive: true });
    await writeFile(
      join(installPath, "agents", "scout.md"),
      ["---", "description: Scout", "---", "", "Map things.", ""].join("\n"),
    );
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "orphan@mkt": [{ installPath, version: "1.0.0" }] },
      }),
    );

    const modules = await discoverClaudeInstalledPlugins("/repo", { home });
    expect(modules.length).toBe(1);
    expect(modules[0]!.manifest?.id).toBe("orphan");
  });

  test("rejects installPath outside ~/.claude/plugins and relative paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-home-escape-"));
    const outside = join(home, "evil-plugin");
    await writeAgentPlugin(outside, "evil-agent");
    const relativeInstall = "relative-not-allowed";
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "evil@x": [{ installPath: outside }],
          "rel@x": [{ installPath: relativeInstall }],
        },
      }),
    );

    const modules = await discoverClaudeInstalledPlugins("/repo", { home });
    expect(modules).toEqual([]);
  });

  test("rejects installPath symlink under plugins root that realpaths outside", async () => {
    // Lexical path is under ~/.claude/plugins; realpath lands outside — same
    // both-sides realpath check as marketplace expand.
    const home = await mkdtemp(join(tmpdir(), "claude-home-install-symlink-"));
    const outsideBase = await mkdtemp(join(tmpdir(), "claude-home-install-out-"));
    try {
      const pluginsRoot = join(home, ".claude", "plugins");
      const outside = join(outsideBase, "evil-plugin");
      const linkPath = join(pluginsRoot, "cache", "escape-link");
      await writeAgentPlugin(outside, "evil-agent");
      await mkdir(join(pluginsRoot, "cache"), { recursive: true });
      symlinkSync(outside, linkPath);
      await writeFile(
        join(pluginsRoot, "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: { "evil@x": [{ installPath: linkPath }] },
        }),
      );

      const modules = await discoverClaudeInstalledPlugins("/repo", { home });
      expect(modules).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(outsideBase, { recursive: true, force: true });
    }
  });

  test("does not import JS entry points at discovery (data-only only)", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-home-no-import-"));
    const installPath = join(home, ".claude", "plugins", "cache", "jsy", "1.0.0");
    await mkdir(installPath, { recursive: true });
    // A JS entry that would throw if imported.
    await writeFile(
      join(installPath, "index.ts"),
      `throw new Error("should-not-import-at-discovery");\n`,
    );
    await writeFile(
      join(installPath, "manifest.json"),
      JSON.stringify({ id: "jsy", name: "jsy", kind: "agent" }),
    );
    // No agents/*.md — data-only returns null; JS must not be imported as fallback.
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "jsy@x": [{ installPath, version: "1.0.0" }] },
      }),
    );

    const modules = await discoverClaudeInstalledPlugins("/repo", { home });
    // No data-only content → skipped; import path never runs (would throw).
    expect(modules).toEqual([]);
  });

  test("resolves marketplace members with ../agents sources under ~/.claude/plugins", async () => {
    // Real Claude marketplaces declare members as ../agents/<name> relative to the
    // install root (sibling directory), still under ~/.claude/plugins. Those must load.
    const home = await mkdtemp(join(tmpdir(), "claude-home-agents-src-"));
    const pluginsRoot = join(home, ".claude", "plugins");
    // installPath is the marketplace root; ../agents/x is a sibling under pluginsRoot.
    const marketplaceRoot = join(pluginsRoot, "cache", "mkt", "bundle");
    const agentDir = join(pluginsRoot, "cache", "mkt", "agents", "scout-agent");
    await writeAgentPlugin(agentDir, "scout-agent");
    await mkdir(join(marketplaceRoot, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        plugins: [{ name: "scout-agent", source: "../agents/scout-agent" }],
      }),
    );
    await mkdir(pluginsRoot, { recursive: true });
    await writeFile(
      join(pluginsRoot, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "bundle@mkt": [{ installPath: marketplaceRoot, version: "1.0.0" }] },
      }),
    );

    const modules = await discoverClaudeInstalledPlugins("/repo", { home });
    expect(modules.map((m) => m.manifest?.id)).toEqual(["scout-agent"]);
    expect(modules[0]!.source).toBe("claude");
    expect(modules[0]!.pluginPath).toBe(agentDir);
  });

  test("rejects absolute marketplace sources and escapes outside ~/.claude/plugins", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-home-src-escape-"));
    const pluginsRoot = join(home, ".claude", "plugins");
    const marketplaceRoot = join(pluginsRoot, "cache", "mkt", "bundle");
    const outside = join(home, "evil-plugin");
    // Sibling of marketplace root, still under ~/.claude/plugins.
    const good = join(pluginsRoot, "cache", "mkt", "plugins", "good-agent");
    await writeAgentPlugin(outside, "evil-agent");
    await writeAgentPlugin(good, "good-agent");
    await mkdir(join(marketplaceRoot, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        plugins: [
          { name: "evil-abs", source: outside },
          // Climb out of ~/.claude/plugins into $home/evil-plugin.
          { name: "evil-escape", source: "../../../../../evil-plugin" },
          { name: "good-agent", source: "../plugins/good-agent" },
        ],
      }),
    );
    await mkdir(pluginsRoot, { recursive: true });
    await writeFile(
      join(pluginsRoot, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "bundle@mkt": [{ installPath: marketplaceRoot, version: "1.0.0" }] },
      }),
    );

    const skips: { source: string; reason: string }[] = [];
    const modules = await discoverClaudeInstalledPlugins("/repo", {
      home,
      onExpandSkip: (skip) => skips.push({ source: skip.source, reason: skip.reason }),
    });
    expect(modules.map((m) => m.manifest?.id)).toEqual(["good-agent"]);
    expect(skips.some((s) => s.reason === "absolute")).toBe(true);
    expect(skips.some((s) => s.reason === "outside-contain-root")).toBe(true);
  });
});
