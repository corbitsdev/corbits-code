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
  "git-worktrees",
  "refactor",
  "pull-request-review",
  "create-issue",
  "linear-issue-workflow",
  "opsh",
  "plan",
] as const;

const SPAWN_RECIPE_SKILLS = ["implement", "scribe", "review", "dispatch", "plan"] as const;

/** use_skill listing + resolve; not slash. No disable-model-invocation. */
const USE_SKILL_ONLY = [
  "dispatch",
  "git-rebase",
  "linear-issue-workflow",
  "style",
  "philosophy",
  "typescript",
  "opsh",
] as const;

/** Background libs: absent from slash and use_skill listing; explicit resolve only. */
const BACKGROUND_ONLY = ["git-worktrees"] as const;

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
const DISABLE_MODEL_INVOCATION = "disable-model-invocation: true";

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

test("corbits-skills catalog lists 17 skills with name and description", async () => {
  expect(SKILL_DIRS).toHaveLength(17);
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

test("implement skill is a sequential Skywalker spawn recipe without a false 4-cap", async () => {
  const skill = await Bun.file(join(pluginRoot, "skills/implement/SKILL.md")).text();
  expect(skill).toContain("You are Skywalker");
  expect(skill).toContain('task(agent="greybeard")');
  expect(skill).toContain('task(agent="build")');
  expect(skill).toContain('task(agent="critique")');
  expect(skill).toContain("Do not invent a worker-count or fan-out ceiling");
  expect(skill).toContain("Close the loop");
  expect(skill).not.toContain("once or twice");
  expect(skill).not.toContain("After two re-fix rounds");
  expect(skill).not.toContain("hard cap 4");
  expect(skill).not.toContain("4 workers");
  expect(skill).not.toContain("max-parallel");
  expect(skill).not.toContain("INTERN_TOOLS");
});

test("style skill is guidance, not ceremony or tool-contract restatement", async () => {
  const skill = await Bun.file(join(pluginRoot, "skills/style/SKILL.md")).text();
  expect(skill).toContain(USER_INVOCABLE_FALSE);
  expect(skill).toContain("Guidance for code and commit quality");
  expect(skill).toContain("git-rebase");
  expect(skill).toContain("Do not refuse the task");
  expect(skill).not.toContain("I have reviewed the style skill");
  expect(skill).not.toContain("good taste");
  expect(skill).not.toContain("ask_operator");
  expect(skill).not.toContain("git rebase -i");
  expect(skill).not.toContain("## Acknowledgment");
});

test("review skill routes critique/neckbeard/greybeard via task or spawn_agent/wait_agents", async () => {
  const skill = await Bun.file(join(pluginRoot, "skills/review/SKILL.md")).text();
  expect(skill).toContain("task(agent=");
  expect(skill).toContain("spawn_agent");
  expect(skill).toContain("wait_agents");
  expect(skill).toContain("returned `agent_id`");
  expect(skill).toContain("critique");
  expect(skill).toContain("neckbeard");
  expect(skill).toContain("greybeard");
  expect(skill).toContain("Do not implement fixes");
  expect(skill).toContain("Findings only");
  expect(skill).not.toContain('task(agent="critique")');
  expect(skill).not.toContain('task(agent="neckbeard")');
  expect(skill).not.toContain('task(agent="greybeard")');
});

test("interview skill is an ask_operator utility with no false caps", async () => {
  const skill = await Bun.file(join(pluginRoot, "skills/interview/SKILL.md")).text();
  expect(skill).toContain("ask_operator");
  expect(skill).toMatch(/utility/i);
  expect(skill).toContain("## Interview findings:");
  expect(skill).toContain("No false caps");
  expect(skill).not.toContain(USER_INVOCABLE_FALSE);
  expect(skill).not.toMatch(/2–4/);
  expect(skill).not.toMatch(/at most \d+/i);
  expect(skill).not.toMatch(/parameter limits/i);
  expect(skill).not.toMatch(/maxItems|minItems|inputSchema/i);
  expect(skill).not.toContain("write a file");
  expect(skill).toContain("never writes a file");
});

test("create-issue is Linear-first without restated MCP tool contracts", async () => {
  const skill = await Bun.file(join(pluginRoot, "skills/create-issue/SKILL.md")).text();
  expect(skill).toContain("mcp__linear__");
  expect(skill).toContain("gh issue create");
  expect(skill).toContain(".corbits/MEMORY.md");
  expect(skill).toContain("Preferred issue tracker:");
  expect(skill).toContain("Do not invent a Linear REST client");
  expect(skill).toContain("Do not restate MCP tool names or schemas");
  // Availability check uses the family prefix; individual MCP tool contracts stay out.
  expect(skill).toContain("`mcp__linear__*`");
  expect(skill).not.toContain("mcp__linear__save_issue");
  expect(skill).not.toContain("mcp__linear__list_teams");
  expect(skill).not.toContain("mcp__linear__prepare_attachment_upload");
  expect(skill).not.toContain("mcp__linear__save_status_update");
});

test("use_skill-only skills set user-invocable: false without disable-model-invocation", async () => {
  for (const name of USE_SKILL_ONLY) {
    const skill = await Bun.file(join(pluginRoot, "skills", name, "SKILL.md")).text();
    expect(skill).toContain(USER_INVOCABLE_FALSE);
    expect(skill).not.toContain(DISABLE_MODEL_INVOCATION);
  }
});

test("background-only skills set both exclusion flags", async () => {
  for (const name of BACKGROUND_ONLY) {
    const skill = await Bun.file(join(pluginRoot, "skills", name, "SKILL.md")).text();
    expect(skill).toContain(USER_INVOCABLE_FALSE);
    expect(skill).toContain(DISABLE_MODEL_INVOCATION);
  }
});

test("only background libs carry disable-model-invocation", async () => {
  for (const name of SKILL_DIRS) {
    const skill = await Bun.file(join(pluginRoot, "skills", name, "SKILL.md")).text();
    if ((BACKGROUND_ONLY as readonly string[]).includes(name)) {
      expect(skill).toContain(DISABLE_MODEL_INVOCATION);
    } else {
      expect(skill).not.toContain(DISABLE_MODEL_INVOCATION);
    }
  }
});

test("linear-issue-workflow references use_skill(git-worktrees)", async () => {
  const skill = await Bun.file(join(pluginRoot, "skills/linear-issue-workflow/SKILL.md")).text();
  expect(skill).toContain('use_skill("git-worktrees")');
  expect(skill).not.toContain("git worktree add");
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
