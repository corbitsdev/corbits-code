import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, describe, beforeEach, afterEach } from "bun:test";

import { discoverSkills, resolveSkillBody } from "../../src/extensions/skills.js";

const fixtureCwd = join(import.meta.dirname, "../fixtures/skill-workspace");
const exampleAgentPlugin = join(import.meta.dirname, "../fixtures/plugins/example-agent");
const pluginDirs = [exampleAgentPlugin];

describe("skill discovery", () => {
  test("discovers a plugin skill with its frontmatter description", async () => {
    const skills = await discoverSkills(fixtureCwd, pluginDirs);
    const scribe = skills.find((s) => s.name === "scribe");
    expect(scribe).toBeDefined();
    expect(scribe!.description.length).toBeGreaterThan(0);
  });

  test("dedupes by name", async () => {
    const names = (await discoverSkills(fixtureCwd, pluginDirs)).map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("skill resolution", () => {
  test("resolves plugin skill body with frontmatter stripped", async () => {
    const body = await resolveSkillBody(fixtureCwd, "scribe", pluginDirs);
    expect(body).toBeDefined();
    expect(body!.startsWith("---")).toBe(false);
    expect(body).toContain("Scribe");
  });

  test("accepts a namespaced ref (plugin:name) and resolves by name", async () => {
    expect(await resolveSkillBody(fixtureCwd, "gaas:scribe", pluginDirs)).toBeDefined();
  });

  test("returns undefined for an unknown skill", async () => {
    expect(await resolveSkillBody(fixtureCwd, "does-not-exist-xyz", pluginDirs)).toBeUndefined();
  });
});

describe("path-like skill refs", () => {
  let pluginRoot: string;

  beforeEach(async () => {
    pluginRoot = await mkdtemp(join(tmpdir(), "skill-path-"));
    await mkdir(join(pluginRoot, "skills", "style"), { recursive: true });
    await writeFile(
      join(pluginRoot, "skills", "style", "SKILL.md"),
      "---\nname: style\n---\nBe clean and direct.\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(pluginRoot, { recursive: true, force: true });
  });

  test("resolves relative dir ref under pluginRoot", async () => {
    const body = await resolveSkillBody(fixtureCwd, "./skills/style", [], {
      pluginRoot,
    });
    expect(body).toBeDefined();
    expect(body).toContain("Be clean and direct.");
    expect(body!.startsWith("---")).toBe(false);
  });

  test("resolves relative SKILL.md file ref under pluginRoot", async () => {
    const body = await resolveSkillBody(fixtureCwd, "./skills/style/SKILL.md", [], {
      pluginRoot,
    });
    expect(body).toBeDefined();
    expect(body).toContain("Be clean and direct.");
  });

  test("resolves path containing slash without ./ prefix", async () => {
    const body = await resolveSkillBody(fixtureCwd, "skills/style", [], {
      pluginRoot,
    });
    expect(body).toBeDefined();
    expect(body).toContain("Be clean and direct.");
  });

  test("bare names still resolve via skillBaseDirs when pluginRoot is set", async () => {
    const body = await resolveSkillBody(fixtureCwd, "scribe", pluginDirs, {
      pluginRoot,
    });
    expect(body).toBeDefined();
    expect(body).toContain("Scribe");
  });

  test("rejects absolute path refs", async () => {
    const abs = join(pluginRoot, "skills", "style");
    expect(
      await resolveSkillBody(fixtureCwd, abs, [], { pluginRoot }),
    ).toBeUndefined();
  });

  test("rejects path escape outside pluginRoot", async () => {
    // Place a tempting skill outside the plugin and try to reach it via ..
    const outside = join(pluginRoot, "..", "outside-skill");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "SKILL.md"), "escaped body\n", "utf8");
    try {
      expect(
        await resolveSkillBody(fixtureCwd, "../outside-skill", [], { pluginRoot }),
      ).toBeUndefined();
      expect(
        await resolveSkillBody(fixtureCwd, "./skills/../../outside-skill", [], {
          pluginRoot,
        }),
      ).toBeUndefined();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("path-like ref without pluginRoot returns undefined", async () => {
    expect(await resolveSkillBody(fixtureCwd, "./skills/style", [])).toBeUndefined();
  });

  test("rejects bare . and .. as invalid skill refs", async () => {
    expect(await resolveSkillBody(fixtureCwd, ".", [], { pluginRoot })).toBeUndefined();
    expect(await resolveSkillBody(fixtureCwd, "..", [], { pluginRoot })).toBeUndefined();
    // Namespaced form still parses to bare . / ..
    expect(await resolveSkillBody(fixtureCwd, "plugin:.", [], { pluginRoot })).toBeUndefined();
    expect(await resolveSkillBody(fixtureCwd, "plugin:..", [], { pluginRoot })).toBeUndefined();
  });

  test("rejects symlink under pluginRoot that escapes outside", async () => {
    // Outside skill body that must never load via a symlink escape.
    const outsideDir = await mkdtemp(join(tmpdir(), "skill-outside-"));
    await writeFile(join(outsideDir, "SKILL.md"), "escaped via symlink\n", "utf8");
    const linkDir = join(pluginRoot, "skills", "escape-link");
    try {
      await symlink(outsideDir, linkDir, "dir");
      expect(
        await resolveSkillBody(fixtureCwd, "./skills/escape-link", [], { pluginRoot }),
      ).toBeUndefined();
      expect(
        await resolveSkillBody(fixtureCwd, "./skills/escape-link/SKILL.md", [], {
          pluginRoot,
        }),
      ).toBeUndefined();
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
