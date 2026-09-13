import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { loadSkillCommands } from "../../src/plugins/skill-commands.js";
import { defined } from "../helpers/defined.js";

const pluginRoot = join(import.meta.dirname, "../../plugins/corbits-skills");

const SKILL_DIRS = [
  "implement",
  "scribe",
  "review",
  "ast-grep",
  "style",
  "philosophy",
  "native-integration",
  "native-runtime",
  "typescript",
  "ponytail",
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

/** use_skill listing + resolve; not slash. No disable-model-invocation. */
const USE_SKILL_ONLY = [
  "git-rebase",
  "linear-issue-workflow",
  "style",
  "philosophy",
  "native-integration",
  "typescript",
  "ponytail",
  "opsh",
] as const;

/** Background libs: absent from slash and use_skill listing; explicit resolve only. */
const BACKGROUND_ONLY = ["git-worktrees"] as const;

/** Bake source only: no slash, no use_skill listing; workers load via bake-skills. */
const BAKE_ONLY = ["idiot-proof", "native-runtime"] as const;

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
  const manifest = (await Bun.file(
    join(pluginRoot, "manifest.json"),
  ).json()) as {
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

test("corbits-skills catalog lists 20 skills with name and description", async () => {
  expect(SKILL_DIRS).toHaveLength(20);
  const entries = await readdir(join(pluginRoot, "skills"), {
    withFileTypes: true,
  });
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
    const skill = await Bun.file(
      join(pluginRoot, "skills", name, "SKILL.md"),
    ).text();
    expect(skill).not.toContain("You are Skywalker");
    expect(skill).not.toMatch(/You are \w+Director/);
    expect(skill).not.toContain("Host is Corbits");
    if (gaasOverlap.has(name)) continue;
    expect(skill).not.toContain("## Acknowledgment");
    expect(skill).not.toMatch(/I have reviewed the .+ skill/);
  }
});

test("use_skill-only skills set user-invocable: false without disable-model-invocation", async () => {
  for (const name of USE_SKILL_ONLY) {
    const skill = await Bun.file(
      join(pluginRoot, "skills", name, "SKILL.md"),
    ).text();
    expect(skill).toContain(USER_INVOCABLE_FALSE);
    expect(skill).not.toContain(DISABLE_MODEL_INVOCATION);
  }
});

test("background-only skills set both exclusion flags", async () => {
  for (const name of BACKGROUND_ONLY) {
    const skill = await Bun.file(
      join(pluginRoot, "skills", name, "SKILL.md"),
    ).text();
    expect(skill).toContain(USER_INVOCABLE_FALSE);
    expect(skill).toContain(DISABLE_MODEL_INVOCATION);
  }
});

test("only background and bake-only skills carry disable-model-invocation", async () => {
  const hidden = new Set<string>([...BACKGROUND_ONLY, ...BAKE_ONLY]);
  for (const name of SKILL_DIRS) {
    const skill = await Bun.file(
      join(pluginRoot, "skills", name, "SKILL.md"),
    ).text();
    if (hidden.has(name)) {
      expect(skill).toContain(DISABLE_MODEL_INVOCATION);
    } else {
      expect(skill).not.toContain(DISABLE_MODEL_INVOCATION);
    }
  }
});

test("review skill is the classify-then-selected-fleet recipe", async () => {
  const skill = await Bun.file(
    join(pluginRoot, "skills/review/SKILL.md"),
  ).text();
  expect(skill).toContain("Classify the review target");
  expect(skill).toContain("Critic always");
  expect(skill).toContain("Greybeard");
  expect(skill).toContain("one target per wave");
  expect(skill).toContain("read the PR tree");
  expect(skill).not.toContain("deep-agent-review");
});

test("review skill recommends the fleet but does not route it or own the worktree", async () => {
  const skill = await Bun.file(
    join(pluginRoot, "skills/review/SKILL.md"),
  ).text();
  expect(skill).toContain("does\nnot route the fleet");
  expect(skill).toContain("the primary (Skywalker orchestrator) dispatches");
  expect(skill).toContain(
    "worktree checkout belongs to `/pull-request-review`",
  );
});

test("review skill gates interview as exception, never ritual", async () => {
  const skill = await Bun.file(
    join(pluginRoot, "skills/review/SKILL.md"),
  ).text();
  expect(skill).toContain("Never run interview as ritual");
});

test("pull-request-review is the worktree surface pass", async () => {
  const skill = await Bun.file(
    join(pluginRoot, "skills/pull-request-review/SKILL.md"),
  ).text();
  expect(skill).toContain("worktree");
  expect(skill).toContain("quality rules only");
  expect(skill).toContain("at most one");
  expect(skill).toContain("Post the Review on GitHub");
  expect(skill).not.toContain("Classify the review target");
});

test("no third review slash exists", () => {
  expect(existsSync(join(pluginRoot, "skills/deep-agent-review"))).toBe(false);
});

test("review skill does not own GitHub posting or Linear In Review", async () => {
  const skill = await Bun.file(
    join(pluginRoot, "skills/review/SKILL.md"),
  ).text();
  expect(skill).not.toContain("Post the Review on GitHub");
  expect(skill).not.toContain(
    "`linear-issue-workflow` owns the In Review write",
  );
  expect(skill).not.toContain("this skill does not set Linear state");
});

test("slash skills do not set user-invocable: false", async () => {
  for (const name of SLASH_SKILLS) {
    const skill = await Bun.file(
      join(pluginRoot, "skills", name, "SKILL.md"),
    ).text();
    expect(skill).not.toContain(USER_INVOCABLE_FALSE);
  }
});

test("Corbits-only skills do not contain GaaS tool names", async () => {
  const corbitsOnly = [
    "plan",
    "git-worktrees",
    "idiot-proof",
    "ponytail",
    "native-runtime",
  ] as const;
  for (const name of corbitsOnly) {
    const files = await listFilesRecursive(join(pluginRoot, "skills", name));
    for (const file of files) {
      const text = await Bun.file(file).text();
      for (const token of BANNED_TOKENS) {
        expect(text).not.toContain(token);
      }
    }
  }
});

test("loadSkillCommands lists exactly the nine slash actions", async () => {
  const cmds = await loadSkillCommands(
    join(import.meta.dirname, "../../plugins/corbits-skills"),
  );
  expect(
    defined(cmds, "skill commands")
      .map((c) => c.name)
      .sort(),
  ).toEqual([
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
