import { test, expect } from "bun:test";
import { symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandPluginPath,
  loadPluginsFromPaths,
  type ExpandPluginPathSkip,
} from "../../src/plugins/loader.js";

test("a marketplace path expands to its declared member plugins", async () => {
  const mods = await loadPluginsFromPaths(["tests/fixtures/marketplace"], process.cwd());
  const ids = mods.map((m) => m.manifest?.id).sort();
  expect(ids).toEqual(["alpha", "beta"]);
});

test("marketplace members load with their full data (agents + tagged skills)", async () => {
  const mods = await loadPluginsFromPaths(["tests/fixtures/marketplace"], process.cwd());
  const alpha = mods.find((m) => m.manifest?.id === "alpha");
  expect(alpha?.manifest?.kind).toBe("command"); // skills-only with a tagged skill
  expect(alpha?.commandPlugin?.commands.map((c) => c.name)).toEqual(["alpha-skill"]);

  const beta = mods.find((m) => m.manifest?.id === "beta");
  expect(beta?.manifest?.kind).toBe("agent"); // has an agent
  expect(beta?.agentPlugin?.agents?.length).toBe(1);
});

test("a normal plugin directory is not expanded (no marketplace.json, no plugins/ root)", async () => {
  const mods = await loadPluginsFromPaths(["tests/fixtures/plugins/example-commands"], process.cwd());
  expect(mods.length).toBe(1);
  expect(mods[0]!.manifest?.id).toBe("example-commands");
});

test("mixed catalog: relative sibling loads; absolute and escape are skipped", async () => {
  const base = await mkdtemp(join(tmpdir(), "corbits-mkt-mixed-"));
  try {
    const root = join(base, "marketplace");
    const sibling = join(base, "agents", "gamma");
    const outside = join(base, "outside", "evil");
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await mkdir(join(root, "plugins", "alpha"), { recursive: true });
    await mkdir(sibling, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(
      join(root, "plugins", "alpha", "manifest.json"),
      JSON.stringify({ id: "alpha", name: "alpha", kind: "command" }),
    );
    await writeFile(
      join(sibling, "manifest.json"),
      JSON.stringify({ id: "gamma", name: "gamma", kind: "command" }),
    );
    await writeFile(
      join(outside, "manifest.json"),
      JSON.stringify({ id: "evil", name: "evil", kind: "command" }),
    );
    await writeFile(
      join(root, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        plugins: [
          { name: "alpha", source: "./plugins/alpha" },
          { name: "gamma", source: "../agents/gamma" },
          { name: "evil-abs", source: outside },
          { name: "evil-escape", source: "../../outside/evil" },
        ],
      }),
    );

    const skips: ExpandPluginPathSkip[] = [];
    // Path-plugin expand: contain under parent of marketplace (sibling tree).
    const members = await expandPluginPath(root, {
      onSkip: (s) => skips.push(s),
    });
    expect(members).toEqual([
      join(root, "plugins", "alpha"),
      sibling,
    ]);
    expect(skips.map((s) => s.reason).sort()).toEqual([
      "absolute",
      "outside-contain-root",
    ]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("multi-level relative under parent contain root is allowed", async () => {
  const base = await mkdtemp(join(tmpdir(), "corbits-mkt-deep-"));
  try {
    const root = join(base, "marketplace");
    const deep = join(base, "agents", "nested", "deep", "delta");
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await mkdir(deep, { recursive: true });
    await writeFile(
      join(deep, "manifest.json"),
      JSON.stringify({ id: "delta", name: "delta", kind: "command" }),
    );
    await writeFile(
      join(root, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        plugins: [{ name: "delta", source: "../agents/nested/deep/delta" }],
      }),
    );

    const skips: ExpandPluginPathSkip[] = [];
    const members = await expandPluginPath(root, {
      onSkip: (s) => skips.push(s),
    });
    expect(members).toEqual([deep]);
    expect(skips).toEqual([]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("symlink under contain root that points outside is rejected", async () => {
  // Two sibling temp trees: contain parent vs true outside target.
  const base = await mkdtemp(join(tmpdir(), "corbits-mkt-symlink-in-"));
  const outsideBase = await mkdtemp(join(tmpdir(), "corbits-mkt-symlink-out-"));
  try {
    const root = join(base, "marketplace");
    const outside = join(outsideBase, "evil");
    const linkParent = join(base, "agents");
    const linkPath = join(linkParent, "escape");
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await mkdir(linkParent, { recursive: true });
    await writeFile(
      join(outside, "manifest.json"),
      JSON.stringify({ id: "evil", name: "evil", kind: "command" }),
    );
    // Lexical path is under parent contain root; realpath lands outside it.
    symlinkSync(outside, linkPath);
    await writeFile(
      join(root, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        plugins: [{ name: "escape", source: "../agents/escape" }],
      }),
    );

    const skips: ExpandPluginPathSkip[] = [];
    const members = await expandPluginPath(root, {
      onSkip: (s) => skips.push(s),
    });
    // No valid members → expand falls back to marketplace root itself.
    expect(members).toEqual([root]);
    expect(skips.map((s) => s.reason)).toEqual(["outside-contain-root"]);
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(outsideBase, { recursive: true, force: true });
  }
});

test("path expand reports skips via onSkip (never silent when callback set)", async () => {
  const base = await mkdtemp(join(tmpdir(), "corbits-mkt-onskip-"));
  try {
    const root = join(base, "marketplace");
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(root, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        plugins: [
          { name: "abs", source: "/tmp/not-a-plugin" },
          { name: "gone", source: "./plugins/missing" },
        ],
      }),
    );
    const skips: ExpandPluginPathSkip[] = [];
    await expandPluginPath(root, { onSkip: (s) => skips.push(s) });
    expect(skips.map((s) => s.reason).sort()).toEqual(["absolute", "missing"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
