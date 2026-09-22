import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { formatAttachedSkillConstraints } from "./attached-skills.js";

async function writePluginSkill(
  pluginRoot: string,
  name: string,
  body: string,
): Promise<void> {
  const dir = join(pluginRoot, "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`,
  );
}

describe("formatAttachedSkillConstraints", () => {
  test("returns undefined when no names are attached", async () => {
    expect(
      await formatAttachedSkillConstraints({
        names: [],
        cwd: "/tmp",
        skillDirs: [],
      }),
    ).toBeUndefined();
  });

  test("injects resolved bodies from plugin skill dirs and notes misses without throwing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "attached-skills-"));
    const pluginRoot = join(cwd, "plugin");
    await writePluginSkill(pluginRoot, "style", "Follow the style guide.");
    const section = await formatAttachedSkillConstraints({
      names: ["style", "philosophy"],
      cwd,
      skillDirs: [pluginRoot],
    });
    expect(section).toContain("# Attached skill constraints");
    expect(section).toContain("Do not use_skill them again");
    expect(section).toContain("do not park, do not ask_director");
    expect(section).toContain("### style");
    expect(section).toContain("Follow the style guide.");
    expect(section).toContain(
      'Attached skill "philosophy" could not be resolved. Proceed under AGENTS.md.',
    );
    expect(section).not.toContain("### philosophy");
  });

  test("does not resolve plugin skills when skillDirs is empty", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "attached-skills-empty-"));
    const pluginRoot = join(cwd, "plugin");
    await writePluginSkill(pluginRoot, "style", "Follow the style guide.");
    const section = await formatAttachedSkillConstraints({
      names: ["style"],
      cwd,
      skillDirs: [],
    });
    expect(section).toContain(
      'Attached skill "style" could not be resolved. Proceed under AGENTS.md.',
    );
    expect(section).not.toContain("Follow the style guide.");
  });
});
