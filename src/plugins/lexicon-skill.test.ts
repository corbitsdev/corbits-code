import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { DIRECTOR_IDS } from "../agent/directors/types.js";
import { isDirectorId, resolveDirector } from "../agent/directors/registry.js";
import { loadSkillCommands } from "./skill-commands.js";
import { defined } from "../testkit/defined.js";

const pluginRoot = join(import.meta.dirname, "../../plugins/corbits-skills");
const skillPath = join(pluginRoot, "skills", "lexicon", "SKILL.md");

describe("lexicon skill shape", () => {
  test("SKILL.md exists with slash-only frontmatter", async () => {
    expect(existsSync(skillPath)).toBe(true);
    const skill = await Bun.file(skillPath).text();
    expect(skill).toContain("name: lexicon");
    expect(skill).toContain("description:");
    expect(skill).not.toContain("user-invocable: false");
    expect(skill).not.toContain("disable-model-invocation");
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
});
