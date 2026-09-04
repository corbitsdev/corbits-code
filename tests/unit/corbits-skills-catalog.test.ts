import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { loadSkillCommands } from "../../src/plugins/skill-commands.js";

const pluginRoot = join(import.meta.dirname, "../../plugins/corbits-skills");

const SKILL_DIRS = [
  "implement",
  "scribe",
  "review",
  "ast-grep",
  "style",
  "philosophy",
  "native-integration",
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
  "idiot-proof",
] as const;

const SPAWN_RECIPE_SKILLS = ["implement"] as const;

/** use_skill listing + resolve; not slash. No disable-model-invocation. */
const USE_SKILL_ONLY = [
  "git-rebase",
  "linear-issue-workflow",
  "style",
  "philosophy",
  "native-integration",
  "typescript",
  "opsh",
] as const;

/** Background libs: absent from slash and use_skill listing; explicit resolve only. */
const BACKGROUND_ONLY = ["git-worktrees"] as const;

/** Bake source only: no slash, no use_skill listing; workers load via bake-skills. */
const BAKE_ONLY = ["idiot-proof"] as const;

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

test("corbits-skills catalog lists 18 skills with name and description", async () => {
  expect(SKILL_DIRS).toHaveLength(18);
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

test("spawn-recipe skills contain spawn_agent(agent=", async () => {
  for (const name of SPAWN_RECIPE_SKILLS) {
    const skill = await Bun.file(join(pluginRoot, "skills", name, "SKILL.md")).text();
    expect(skill).toContain("spawn_agent(agent=");
  }
});

test("idiot-proof is a bake-only less-is-more bar", async () => {
  const skill = await Bun.file(join(pluginRoot, "skills/idiot-proof/SKILL.md")).text();
  expect(skill).toContain(USER_INVOCABLE_FALSE);
  expect(skill).toContain(DISABLE_MODEL_INVOCATION);
  expect(skill).toContain("Prefer deletion over addition");
  expect(skill).toContain("Do not copy");
  expect(skill).toContain("files you already touch");
  expect(skill).toContain("Read the target");
  expect(skill).toContain("Do not fix");
});

test("typescript skill guides TS quality without fake enforcement", async () => {
  const skill = await Bun.file(join(pluginRoot, "skills/typescript/SKILL.md")).text();
  expect(skill).toContain(USER_INVOCABLE_FALSE);
  expect(skill).toContain("import type");
  expect(skill).toContain("arktype");
  expect(skill).toContain("unknown");
  expect(skill).toContain("create*");
  expect(skill).toContain("bun:test");
  expect(skill).toContain("Guidance for TypeScript output quality");
  expect(skill).toContain("When project conventions disagree");
  expect(skill).not.toContain('import t from "tap"');
  expect(skill).not.toContain("new Cache");
  expect(skill).not.toMatch(/^## Quick Reference$/m);
  expect(skill).not.toMatch(/^### Don't$/m);
});

test("implement skill is a per-commit workflow without a false 4-cap", async () => {
  const skill = await Bun.file(join(pluginRoot, "skills/implement/SKILL.md")).text();
  expect(skill).toContain('spawn_agent(agent="greybeard")');
  expect(skill).toContain('spawn_agent(agent="critic")');
  expect(skill).toContain("Do not invent a worker-count or fan-out ceiling");
  expect(skill).toContain("Close the loop");
  expect(skill).not.toContain("once or twice");
  expect(skill).not.toContain("After two re-fix rounds");
  expect(skill).not.toContain("hard cap 4");
  expect(skill).not.toContain("4 workers");
  expect(skill).not.toContain("max-parallel");
  expect(skill).not.toContain("INTERN_TOOLS");
});

test("first-party skills are how-to playbooks, not director personas", async () => {
  const gaasOverlap = new Set([
    "ast-grep",
    "create-issue",
    "git-rebase",
    "implement",
    "interview",
    "linear-issue-workflow",
    "opsh",
    "philosophy",
    "pull-request-review",
    "refactor",
    "review",
    "scribe",
    "style",
    "typescript",
  ]);
  for (const name of SKILL_DIRS) {
    const skill = await Bun.file(join(pluginRoot, "skills", name, "SKILL.md")).text();
    expect(skill).not.toContain("You are Skywalker");
    expect(skill).not.toMatch(/You are \w+Director/);
    expect(skill).not.toContain("Host is Corbits");
    if (gaasOverlap.has(name)) continue;
    expect(skill).not.toContain("## Acknowledgment");
    expect(skill).not.toMatch(/I have reviewed the .+ skill/);
  }
});

test("style skill is 1:1 with GaaS style", async () => {
  const skill = await Bun.file(join(pluginRoot, "skills/style/SKILL.md")).text();
  expect(skill).toContain(USER_INVOCABLE_FALSE);
  expect(skill).not.toContain(DISABLE_MODEL_INVOCATION);
  expect(skill).toContain("## Git Repository Requirement");
  expect(skill).toContain("refuse to proceed");
  expect(skill).toContain("git rebase -i");
  expect(skill).toContain("## Acknowledgment");
  expect(skill).toContain(
    "I have reviewed the style skill, and I am ready to proceed in good taste.",
  );
  expect(skill).not.toContain("Do not refuse the task");
});

test("philosophy skill is 1:1 with GaaS philosophy", async () => {
  const skill = await Bun.file(join(pluginRoot, "skills/philosophy/SKILL.md")).text();
  expect(skill).toContain(USER_INVOCABLE_FALSE);
  expect(skill).not.toContain(DISABLE_MODEL_INVOCATION);
  expect(skill).toContain("## Guiding Principles");
  expect(skill).toContain("## Constraint Ownership");
  expect(skill).toContain("exactly one");
  expect(skill).toContain("## Backwards Compatibility");
  expect(skill).toContain("Pragmatic over idealistic");
  expect(skill).toContain("## Acknowledgment");
  expect(skill).toContain("I have reviewed the philosophy skill");
  expect(skill).not.toContain("write_file");
  expect(skill).not.toContain("run_shell");
  expect(skill).not.toContain("use_skill(");
});

test("review skill is a code-review playbook, not a director router", async () => {
  const skill = await Bun.file(join(pluginRoot, "skills/review/SKILL.md")).text();
  expect(skill).toContain("git diff <base>...HEAD");
  expect(skill).toContain("Cite the Check");
  expect(skill).toContain("Signal Over Noise");
  expect(skill).toContain("Pre-existing Code");
  expect(skill).toContain("do not implement fixes");
  expect(skill).toContain("Findings only");
  expect(skill).not.toContain("spawn_agent");
  expect(skill).not.toContain("wait_agents");
  expect(skill).not.toContain('task(agent="critic")');
  expect(skill).not.toContain('task(agent="neckbeard")');
  expect(skill).not.toContain('task(agent="greybeard")');
});

test("pull-request-review checkouts a worktree then loads the review skill", async () => {
  const skill = await Bun.file(join(pluginRoot, "skills/pull-request-review/SKILL.md")).text();
  expect(skill).toContain("git worktree add");
  expect(skill).toContain("review` skill");
  expect(skill).toContain("Do not implement fixes");
  expect(skill).not.toContain("spawn_agent");
  expect(skill).not.toContain('task(agent="critic")');
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

test("only background and bake-only skills carry disable-model-invocation", async () => {
  const hidden = new Set<string>([...BACKGROUND_ONLY, ...BAKE_ONLY]);
  for (const name of SKILL_DIRS) {
    const skill = await Bun.file(join(pluginRoot, "skills", name, "SKILL.md")).text();
    if (hidden.has(name)) {
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

test("linear-issue-workflow moves ready-for-review PRs to In Review", async () => {
  const skill = await Bun.file(join(pluginRoot, "skills/linear-issue-workflow/SKILL.md")).text();
  expect(skill).toContain('set the issue state to "In Review"');
  expect(skill).toMatch(/ready for review/);
  expect(skill).toContain("Draft or WIP PRs stay **In Progress**");
  expect(skill).toContain("Draft or WIP PRs stay In Progress");
  expect(skill).toContain("Do not mark the Linear issue Done on open PR alone");
  expect(skill).toContain("Do not leave it In Review after merge when work remains");
});

test("review skill does not own the Linear In Review write", async () => {
  const skill = await Bun.file(join(pluginRoot, "skills/review/SKILL.md")).text();
  expect(skill).toContain("`linear-issue-workflow` owns the In Review write");
  expect(skill).not.toContain("Reviewers do not change Linear state");
});

test("slash skills do not set user-invocable: false", async () => {
  for (const name of SLASH_SKILLS) {
    const skill = await Bun.file(join(pluginRoot, "skills", name, "SKILL.md")).text();
    expect(skill).not.toContain(USER_INVOCABLE_FALSE);
  }
});

test("corbits-skills plugin files contain no banned tokens outside native-integration", async () => {
  const nativeRoot = join(pluginRoot, "skills", "native-integration");
  const files = await listFilesRecursive(pluginRoot);
  for (const file of files) {
    if (file.startsWith(nativeRoot)) continue;
    const text = await Bun.file(file).text();
    for (const token of BANNED_TOKENS) {
      expect(text).not.toContain(token);
    }
  }
});

test("native-integration maps GaaS tool names and parks Corbits extras", async () => {
  const skill = await Bun.file(join(pluginRoot, "skills/native-integration/SKILL.md")).text();
  expect(skill).toContain(USER_INVOCABLE_FALSE);
  expect(skill).not.toContain(DISABLE_MODEL_INVOCATION);
  expect(skill).toContain("TaskCreate");
  expect(skill).toContain("@greybeard");
  expect(skill).toContain('intent="general"');
  expect(skill).toContain("manage_tasks");
  expect(skill).toContain('spawn_agent(agent="greybeard")');
  expect(skill).toContain("ask_operator");
  expect(skill).toContain("ask_director");
  expect(skill).toContain("folder without `.git`");
  expect(skill).toContain("gh pr review");
  expect(skill).toContain("Preferred issue tracker");
  expect(skill).toContain("/review");
  expect(skill).toContain("/create-issue");
  expect(skill).toContain("plan");
  expect(skill).toContain("git-worktrees");
  expect(skill).toContain("idiot-proof");
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
