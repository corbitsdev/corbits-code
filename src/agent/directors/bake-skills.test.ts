import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatBakedOptionalSkills, loadBakedSkillBody } from "./bake-skills.js";

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw.trim();
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw.trim();
  return raw.slice(end + 4).trim();
}

const styleOnDisk = stripFrontmatter(
  readFileSync(
    join(import.meta.dirname, "../../../plugins/corbits-skills/skills/style/SKILL.md"),
    "utf8",
  ),
);
const philosophyOnDisk = stripFrontmatter(
  readFileSync(
    join(import.meta.dirname, "../../../plugins/corbits-skills/skills/philosophy/SKILL.md"),
    "utf8",
  ),
);

describe("loadBakedSkillBody", () => {
  test("returns first-party style and philosophy bodies matching SKILL.md", () => {
    expect(loadBakedSkillBody("style")).toBe(styleOnDisk);
    expect(loadBakedSkillBody("philosophy")).toBe(philosophyOnDisk);
  });

  test("returns undefined for unknown skill names", () => {
    expect(loadBakedSkillBody("does-not-exist-xyz")).toBeUndefined();
  });
});

describe("formatBakedOptionalSkills", () => {
  test("includes named bodies under Baked skill guidance", () => {
    const text = formatBakedOptionalSkills(["style", "philosophy"]);
    expect(text).toContain("# Baked skill guidance");
    expect(text).toContain("### style");
    expect(text).toContain("### philosophy");
    expect(text).toContain(styleOnDisk);
    expect(text).toContain(philosophyOnDisk);
    expect(text).toContain("use_skill is not mounted on workers");
  });

  test("skips missing names without inventing content", () => {
    const text = formatBakedOptionalSkills(["does-not-exist-xyz"]);
    expect(text).toBe("");
  });

  test("partial miss does not claim Full skill bodies", () => {
    const text = formatBakedOptionalSkills(["style", "does-not-exist-xyz"]);
    expect(text).toContain("### style");
    expect(text).toContain("Resolved skill bodies");
    expect(text).not.toContain("Full skill bodies");
    expect(text).not.toContain("### does-not-exist-xyz");
  });
});
