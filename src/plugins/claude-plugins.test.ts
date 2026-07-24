import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverClaudeInstalledPlugins } from "./loader.js";
import { resolveAgentPluginProfiles } from "./agent-plugins.js";

async function writeAgentPlugin(dir: string, id: string): Promise<void> {
  await mkdir(join(dir, "agents"), { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({ id, name: id, kind: "agent" }),
  );
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
});
