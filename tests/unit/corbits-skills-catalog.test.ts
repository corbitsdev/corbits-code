import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { loadSkillCommands } from "../../src/plugins/skill-commands.js";

const pluginRoot = join(import.meta.dirname, "../../plugins/corbits-skills");

const SKILL_DIRS = [
  "implement",
  "dispatch",
  "scribe",
  "review",
  "ast-grep",
  "style",
  "philosophy",
  "typescript",
  "interview",
  "git-rebase",
  "refactor",
  "pull-request-review",
  "create-issue",
  "linear-issue-workflow",
  "opsh",
  "plan",
] as const;

const SPAWN_RECIPE_SKILLS = ["implement", "scribe", "review", "dispatch", "plan"] as const;

const USE_SKILL_ONLY = [
  "dispatch",
  "git-rebase",
  "linear-issue-workflow",
  "style",
  "philosophy",
  "typescript",
  "opsh",
] as const;

const SLASH_SKILLS = [
  "implement",
  "refactor",
  "review",
  "pull-request-review",
  "create-issue",
  "scribe",
  "interview",
  "ast-grep",
  "plan",
] as const;

const BANNED_TOKENS = ["TaskCreate", "@greybeard", 'intent="general"'] as const;

const USER_INVOCABLE_FALSE = "user-invocable: false";

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

test("corbits-skills manifest is a default-enabled command plugin", async () => {
  const manifest = (await Bun.file(join(pluginRoot, "manifest.json")).json()) as {
    id: string;
    kind: string;
    defaultEnabled: boolean;
  };
  expect(manifest.id).toBe("corbits-skills");
  expect(manifest.kind).toBe("command");
  expect(manifest.defaultEnabled).toBe(true);
});

test("corbits-skills plugin has no agents directory", () => {
  expect(existsSync(join(pluginRoot, "agents"))).toBe(false);
});

test("corbits-skills catalog lists 16 skills with name and description", async () => {
  expect(SKILL_DIRS).toHaveLength(16);
  const entries = await readdir(join(pluginRoot, "skills"), { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect(dirs).toEqual([...SKILL_DIRS].sort());
  for (const name of SKILL_DIRS) {
    const skillPath = join(pluginRoot, "skills", name, "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const skill = await Bun.file(skillPath).text();
    expect(skill).toContain("name:");
    expect(skill).toContain("description:");
  }
});

test("spawn-recipe skills contain task(agent=", async () => {
  for (const name of SPAWN_RECIPE_SKILLS) {
    const skill = await Bun.file(join(pluginRoot, "skills", name, "SKILL.md")).text();
    expect(skill).toContain("task(agent=");
  }
});

test("philosophy skill is guidance without fake enforcement", async () => {
  const skill = await Bun.file(join(pluginRoot, "skills/philosophy/SKILL.md")).text();
  expect(skill).toContain(USER_INVOCABLE_FALSE);
  expect(skill).toContain("Constraint ownership");
  expect(skill).toContain("exactly one");
  expect(skill).toContain("guidance for choices");
  expect(skill).toContain("Backwards compatibility");
  expect(skill).toContain("Pragmatic over idealistic");
  expect(skill).not.toContain("## Acknowledgment");
  expect(skill).not.toContain("I have reviewed the philosophy skill");
  expect(skill).not.toContain("write_file");
  expect(skill).not.toContain("run_shell");
  expect(skill).not.toContain("use_skill(");
});

test("create-issue selects Linear MCP, GitHub gh, and MEMORY.md preference", async () => {
  const skill = await Bun.file(join(pluginRoot, "skills/create-issue/SKILL.md")).text();
  expect(skill).toContain("mcp__linear__");
  expect(skill).toContain("gh issue create");
  expect(skill).toContain(".corbits/MEMORY.md");
  expect(skill).toContain("Preferred issue tracker:");
});

test("use_skill-only skills set user-invocable: false", async () => {
  for (const name of USE_SKILL_ONLY) {
    const skill = await Bun.file(join(pluginRoot, "skills", name, "SKILL.md")).text();
    expect(skill).toContain(USER_INVOCABLE_FALSE);
  }
});

test("slash skills do not set user-invocable: false", async () => {
  for (const name of SLASH_SKILLS) {
    const skill = await Bun.file(join(pluginRoot, "skills", name, "SKILL.md")).text();
    expect(skill).not.toContain(USER_INVOCABLE_FALSE);
  }
});

test("corbits-skills plugin files contain no banned tokens", async () => {
  const files = await listFilesRecursive(pluginRoot);
  for (const file of files) {
    const text = await Bun.file(file).text();
    for (const token of BANNED_TOKENS) {
      expect(text).not.toContain(token);
    }
  }
});

test("loadSkillCommands lists exactly the nine slash actions", async () => {
  const cmds = await loadSkillCommands(join(import.meta.dirname, "../../plugins/corbits-skills"));
  expect(cmds!.map((c) => c.name).sort()).toEqual([
    "ast-grep",
    "create-issue",
    "implement",
    "interview",
    "plan",
    "pull-request-review",
    "refactor",
    "review",
    "scribe",
  ]);
});
