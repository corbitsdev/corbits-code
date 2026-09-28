import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { loadSkillCommands } from "./skill-commands.js";
import { defined } from "../testkit/defined.js";

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
  "lexicon",
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

/** Hidden from listing: no slash, no skill_search description; workers load by exact name via use_skill. */
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
  "lexicon",
] as const;

const USER_INVOCABLE_FALSE = "user-invocable: false";
const DISABLE_MODEL_INVOCATION = "disable-model-invocation: true";

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

test("corbits-skills catalog lists 21 skills with name and description", async () => {
  expect(SKILL_DIRS).toHaveLength(21);
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

test("slash skills do not set user-invocable: false", async () => {
  for (const name of SLASH_SKILLS) {
    const skill = await Bun.file(
      join(pluginRoot, "skills", name, "SKILL.md"),
    ).text();
    expect(skill).not.toContain(USER_INVOCABLE_FALSE);
  }
});

test("loadSkillCommands lists exactly the ten slash actions", async () => {
  const cmds = await loadSkillCommands(pluginRoot);
  expect(
    defined(cmds, "skill commands")
      .map((c) => c.name)
      .sort(),
  ).toEqual([
    "ast-grep",
    "create-issue",
    "implement",
    "interview",
    "lexicon",
    "plan",
    "pull-request-review",
    "refactor",
    "review",
    "scribe",
  ]);
});
