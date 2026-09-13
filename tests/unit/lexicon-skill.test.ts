import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { DIRECTOR_IDS } from "../../src/agent/directors/types.js";
import {
  isDirectorId,
  resolveDirector,
} from "../../src/agent/directors/registry.js";
import { loadSkillCommands } from "../../src/plugins/skill-commands.js";
import { defined } from "../helpers/defined.js";

const pluginRoot = join(import.meta.dirname, "../../plugins/corbits-skills");
const skillPath = join(pluginRoot, "skills", "lexicon", "SKILL.md");

const FORBIDDEN_SPAWN = /spawn_agent\(agent=.lexicon.\)/;

describe("lexicon skill shape", () => {
  test("SKILL.md exists with slash-only frontmatter", async () => {
    expect(existsSync(skillPath)).toBe(true);
    const skill = await Bun.file(skillPath).text();
    expect(skill).toContain("name: lexicon");
    expect(skill).toContain("description:");
    expect(skill).not.toContain("user-invocable: false");
    expect(skill).not.toContain("disable-model-invocation");
  });

  test("skill owns the drift/size/issue contract", async () => {
    const skill = await Bun.file(skillPath).text();
    expect(skill).toContain("pinned commit");
    expect(skill).toContain("prompt-sizes");
    expect(skill).toContain("directorPromptSizeTable");
    expect(skill).toContain("linear-issue-workflow");
  });

  test("lexicon is a slash command", async () => {
    const cmds = await loadSkillCommands(pluginRoot);
    expect(defined(cmds, "skill commands").map((c) => c.name)).toContain(
      "lexicon",
    );
  });
});

describe("lexicon invocation gating", () => {
  test("no lexicon director exists", () => {
    expect(
      existsSync(
        join(import.meta.dirname, "../../src/agent/directors/lexicon"),
      ),
    ).toBe(false);
    expect(DIRECTOR_IDS).not.toContain("lexicon");
    expect(isDirectorId("lexicon")).toBe(false);
  });

  test('resolveDirector rejects agent "lexicon"', () => {
    const r = resolveDirector({ agentId: "lexicon" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Unknown director");
  });

  test("no director surface references lexicon", async () => {
    for (const rel of [
      "src/agent/directors/registry.ts",
      "src/agent/directors/types.ts",
      "src/agent/directors/skywalker/package.ts",
    ]) {
      const text = await Bun.file(
        join(import.meta.dirname, "../..", rel),
      ).text();
      expect(text).not.toContain("lexicon");
    }
  });

  test('spawn_agent(agent="lexicon") appears only as a prohibition', async () => {
    const skill = await Bun.file(skillPath).text();
    const lines = skill
      .split("\n")
      .filter((line) => FORBIDDEN_SPAWN.test(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/Never call/);
    }
  });
});
