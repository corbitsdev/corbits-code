import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  createUseSkillTool,
  useSkillDefinition,
  workerUseSkillDefinition,
} from "./use-skill.js";

async function fixtureWithHiddenSkill(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "corbits-use-skill-"));
  const skillDir = join(cwd, ".agents", "skills", "git-worktrees");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: git-worktrees\nuser-invocable: false\ndisable-model-invocation: true\ndescription: bg\n---\nCreate worktree recipe.\n",
  );
  return cwd;
}

function call(
  tool: ReturnType<typeof createUseSkillTool>,
  args: Record<string, unknown>,
): Promise<string> {
  if (tool.kind !== "string") throw new Error("expected string tool");
  return tool.handler(args, new AbortController().signal);
}

describe("useSkillDefinition", () => {
  test("primary catalog copy does not imply attached skills", () => {
    expect(useSkillDefinition.name).toBe("use_skill");
    expect(useSkillDefinition.description).toContain("full instructions");
    expect(useSkillDefinition.description).toContain("skill_search");
    expect(useSkillDefinition.description).not.toMatch(/attached/i);
  });

  test("worker copy tells the model not to reload attached skills", () => {
    expect(workerUseSkillDefinition.name).toBe("use_skill");
    expect(workerUseSkillDefinition.description).toContain("attached");
    expect(workerUseSkillDefinition.description).toMatch(/do not reload/i);
  });
});

describe("createUseSkillTool allowedNames", () => {
  test("omitted allowedNames still loads a disable-model-invocation skill", async () => {
    const cwd = await fixtureWithHiddenSkill();
    const tool = createUseSkillTool(cwd);
    const out = await call(tool, { name: "git-worktrees" });
    expect(out).toContain("Create worktree recipe.");
  });

  test("out-of-set name with allowedNames defined returns the not-available string without loading", async () => {
    const cwd = await fixtureWithHiddenSkill();
    const tool = createUseSkillTool(cwd, [], undefined, ["scribe"]);
    const out = await call(tool, { name: "git-worktrees" });
    expect(out).toBe('No skill named "git-worktrees" is available.');
    expect(out).not.toContain("Create worktree recipe.");
  });

  test("in-set name with allowedNames defined still loads", async () => {
    const cwd = await fixtureWithHiddenSkill();
    const tool = createUseSkillTool(cwd, [], undefined, ["git-worktrees"]);
    const out = await call(tool, { name: "git-worktrees" });
    expect(out).toContain("Create worktree recipe.");
  });
});
