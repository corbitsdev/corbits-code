import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, describe, beforeEach, afterEach } from "bun:test";

import { discoverSkills, resolveSkillBody } from "./skills.js";
import { defined } from "../../testkit/defined.js";
import { withMockedHomedir } from "../../testkit/mock-module.js";

const fixtureCwd = join(import.meta.dirname, "../../fixtures/skill-workspace");
const exampleAgentPlugin = join(
  import.meta.dirname,
  "../../fixtures/plugins/example-agent",
);
const pluginDirs = [exampleAgentPlugin];

describe("skill discovery", () => {
  test("discovers a plugin skill with its frontmatter description", async () => {
    const skills = await discoverSkills(fixtureCwd, pluginDirs);
    const scribe = skills.find((s) => s.name === "scribe");
    expect(scribe).toBeDefined();
    expect(defined(scribe, "scribe skill").description.length).toBeGreaterThan(
      0,
    );
  });

  test("dedupes by name", async () => {
    const names = (await discoverSkills(fixtureCwd, pluginDirs)).map(
      (s) => s.name,
    );
    expect(new Set(names).size).toBe(names.length);
  });

  test("skips disable-model-invocation:true from listing but still occupies seen", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-dmi-"));
    const high = join(root, "high");
    const low = join(root, "low");
    try {
      await mkdir(join(high, "skills", "bg-lib"), { recursive: true });
      await mkdir(join(low, "skills", "bg-lib"), { recursive: true });
      await writeFile(
        join(high, "skills", "bg-lib", "SKILL.md"),
        "---\nname: bg-lib\ndescription: high priority background\ndisable-model-invocation: true\n---\nHigh body.\n",
        "utf8",
      );
      await writeFile(
        join(low, "skills", "bg-lib", "SKILL.md"),
        "---\nname: bg-lib\ndescription: leaked lower priority\n---\nLow body that must not list.\n",
        "utf8",
      );
      const skills = await discoverSkills(root, [high, low]);
      expect(skills.find((s) => s.name === "bg-lib")).toBeUndefined();
      expect(skills.some((s) => s.description.includes("leaked"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("lists a sibling skill when a peer has disable-model-invocation", async () => {
    const plugin = await mkdtemp(join(tmpdir(), "skill-dmi-peer-"));
    try {
      await mkdir(join(plugin, "skills", "bg-lib"), { recursive: true });
      await mkdir(join(plugin, "skills", "visible"), { recursive: true });
      await writeFile(
        join(plugin, "skills", "bg-lib", "SKILL.md"),
        "---\nname: bg-lib\ndescription: background\ndisable-model-invocation: true\n---\nHidden.\n",
        "utf8",
      );
      await writeFile(
        join(plugin, "skills", "visible", "SKILL.md"),
        "---\nname: visible\ndescription: still listed\n---\nVisible body.\n",
        "utf8",
      );
      const skills = await discoverSkills(plugin, [plugin]);
      expect(skills.find((s) => s.name === "bg-lib")).toBeUndefined();
      expect(skills.find((s) => s.name === "visible")).toEqual({
        name: "visible",
        description: "still listed",
      });
    } finally {
      await rm(plugin, { recursive: true, force: true });
    }
  });

  test("discovers a project .corbits/skills skill", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "skill-corbits-project-"));
    try {
      await mkdir(join(cwd, ".corbits", "skills", "local-playbook"), {
        recursive: true,
      });
      await writeFile(
        join(cwd, ".corbits", "skills", "local-playbook", "SKILL.md"),
        "---\nname: local-playbook\ndescription: project corbits skill\n---\nProject body.\n",
        "utf8",
      );
      const skills = await discoverSkills(cwd, []);
      expect(skills.find((s) => s.name === "local-playbook")).toEqual({
        name: "local-playbook",
        description: "project corbits skill",
      });
      const body = await resolveSkillBody(cwd, "local-playbook", []);
      expect(body).toContain("Project body.");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("discovers a user-global ~/.corbits/skills skill (tmp HOME)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "skill-corbits-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "skill-corbits-home-"));
    try {
      await mkdir(join(home, ".corbits", "skills", "user-playbook"), {
        recursive: true,
      });
      await writeFile(
        join(home, ".corbits", "skills", "user-playbook", "SKILL.md"),
        "---\nname: user-playbook\ndescription: user global skill\n---\nUser body.\n",
        "utf8",
      );
      await withMockedHomedir(home, async () => {
        const skills = await discoverSkills(cwd, []);
        expect(skills.find((s) => s.name === "user-playbook")).toEqual({
          name: "user-playbook",
          description: "user global skill",
        });
        const body = await resolveSkillBody(cwd, "user-playbook", []);
        expect(body).toContain("User body.");
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("project .corbits/skills shadows the same name in user-global", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "skill-corbits-shadow-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "skill-corbits-shadow-home-"));
    try {
      await mkdir(join(cwd, ".corbits", "skills", "shared"), {
        recursive: true,
      });
      await mkdir(join(home, ".corbits", "skills", "shared"), {
        recursive: true,
      });
      await writeFile(
        join(cwd, ".corbits", "skills", "shared", "SKILL.md"),
        "---\nname: shared\ndescription: project wins\n---\nProject shared.\n",
        "utf8",
      );
      await writeFile(
        join(home, ".corbits", "skills", "shared", "SKILL.md"),
        "---\nname: shared\ndescription: user should lose\n---\nUser shared.\n",
        "utf8",
      );
      await withMockedHomedir(home, async () => {
        const skills = await discoverSkills(cwd, []);
        expect(skills.find((s) => s.name === "shared")).toEqual({
          name: "shared",
          description: "project wins",
        });
        const body = await resolveSkillBody(cwd, "shared", []);
        expect(body).toContain("Project shared.");
        expect(body).not.toContain("User shared.");
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("skill resolution", () => {
  test("resolves plugin skill body with frontmatter stripped", async () => {
    const body = await resolveSkillBody(fixtureCwd, "scribe", pluginDirs);
    expect(body).toBeDefined();
    expect(defined(body, "skill body").startsWith("---")).toBe(false);
    expect(body).toContain("Scribe");
  });

  test("accepts a namespaced ref (plugin:name) and resolves by name", async () => {
    expect(
      await resolveSkillBody(fixtureCwd, "gaas:scribe", pluginDirs),
    ).toBeDefined();
  });

  test("returns undefined for an unknown skill", async () => {
    expect(
      await resolveSkillBody(fixtureCwd, "does-not-exist-xyz", pluginDirs),
    ).toBeUndefined();
  });

  test("resolveSkillBody still loads disable-model-invocation skills by name", async () => {
    const plugin = await mkdtemp(join(tmpdir(), "skill-dmi-resolve-"));
    try {
      await mkdir(join(plugin, "skills", "git-worktrees"), { recursive: true });
      await writeFile(
        join(plugin, "skills", "git-worktrees", "SKILL.md"),
        "---\nname: git-worktrees\nuser-invocable: false\ndisable-model-invocation: true\ndescription: bg\n---\nCreate worktree recipe.\n",
        "utf8",
      );
      const emptyHome = await mkdtemp(join(tmpdir(), "skill-dmi-home-"));
      try {
        await withMockedHomedir(emptyHome, async () => {
          expect(await discoverSkills(plugin, [plugin])).toEqual([]);
          const body = await resolveSkillBody(plugin, "git-worktrees", [
            plugin,
          ]);
          expect(body).toBeDefined();
          expect(body).toContain("Create worktree recipe.");
          expect(defined(body, "skill body").startsWith("---")).toBe(false);
        });
      } finally {
        await rm(emptyHome, { recursive: true, force: true });
      }
    } finally {
      await rm(plugin, { recursive: true, force: true });
    }
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

  test("resolves path-like refs under pluginRoot", async () => {
    for (const ref of [
      "./skills/style",
      "./skills/style/SKILL.md",
      "skills/style",
    ]) {
      const body = await resolveSkillBody(fixtureCwd, ref, [], { pluginRoot });
      expect(body).toBeDefined();
      expect(body).toContain("Be clean and direct.");
      expect(defined(body, "skill body").startsWith("---")).toBe(false);
    }
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
        await resolveSkillBody(fixtureCwd, "../outside-skill", [], {
          pluginRoot,
        }),
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
    expect(
      await resolveSkillBody(fixtureCwd, "./skills/style", []),
    ).toBeUndefined();
  });

  test("rejects bare . and .. as invalid skill refs", async () => {
    expect(
      await resolveSkillBody(fixtureCwd, ".", [], { pluginRoot }),
    ).toBeUndefined();
    expect(
      await resolveSkillBody(fixtureCwd, "..", [], { pluginRoot }),
    ).toBeUndefined();
    // Namespaced form still parses to bare . / ..
    expect(
      await resolveSkillBody(fixtureCwd, "plugin:.", [], { pluginRoot }),
    ).toBeUndefined();
    expect(
      await resolveSkillBody(fixtureCwd, "plugin:..", [], { pluginRoot }),
    ).toBeUndefined();
  });

  test("rejects symlink under pluginRoot that escapes outside", async () => {
    // Outside skill body that must never load via a symlink escape.
    const outsideDir = await mkdtemp(join(tmpdir(), "skill-outside-"));
    await writeFile(
      join(outsideDir, "SKILL.md"),
      "escaped via symlink\n",
      "utf8",
    );
    const linkDir = join(pluginRoot, "skills", "escape-link");
    try {
      await symlink(outsideDir, linkDir, "dir");
      expect(
        await resolveSkillBody(fixtureCwd, "./skills/escape-link", [], {
          pluginRoot,
        }),
      ).toBeUndefined();
      expect(
        await resolveSkillBody(
          fixtureCwd,
          "./skills/escape-link/SKILL.md",
          [],
          {
            pluginRoot,
          },
        ),
      ).toBeUndefined();
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
