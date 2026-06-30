import { test, expect, describe } from "bun:test";
import { discoverSkills, resolveSkillBody } from "../../src/extensions/skills.js";

describe("skill discovery", () => {
  test("discovers the bundled scribe skill with its frontmatter description", async () => {
    const skills = await discoverSkills(process.cwd(), []);
    const scribe = skills.find((s) => s.name === "scribe");
    expect(scribe).toBeDefined();
    expect(scribe!.description.length).toBeGreaterThan(0);
  });

  test("dedupes by name", async () => {
    const names = (await discoverSkills(process.cwd(), [])).map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("skill resolution", () => {
  test("resolves the bundled scribe body with frontmatter stripped", async () => {
    const body = await resolveSkillBody(process.cwd(), "scribe", []);
    expect(body).toBeDefined();
    expect(body!.startsWith("---")).toBe(false);
    expect(body).toContain("Scribe");
  });

  test("accepts a namespaced ref (plugin:name) and resolves by name", async () => {
    expect(await resolveSkillBody(process.cwd(), "gaas:scribe", [])).toBeDefined();
  });

  test("returns undefined for an unknown skill", async () => {
    expect(await resolveSkillBody(process.cwd(), "does-not-exist-xyz", [])).toBeUndefined();
  });
});
