import { join } from "node:path";
import { test, expect, describe } from "bun:test";

import { discoverSkills, resolveSkillBody } from "../../src/extensions/skills.js";

const fixtureCwd = join(import.meta.dirname, "../fixtures/skill-workspace");
const exampleAgentPlugin = join(import.meta.dirname, "../fixtures/plugins/example-agent");
const pluginDirs = [exampleAgentPlugin];

describe("skill discovery", () => {
  test("discovers a plugin skill with its frontmatter description", async () => {
    const skills = await discoverSkills(fixtureCwd, pluginDirs);
    const scribe = skills.find((s) => s.name === "scribe");
    expect(scribe).toBeDefined();
    expect(scribe!.description.length).toBeGreaterThan(0);
  });

  test("dedupes by name", async () => {
    const names = (await discoverSkills(fixtureCwd, pluginDirs)).map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("skill resolution", () => {
  test("resolves plugin skill body with frontmatter stripped", async () => {
    const body = await resolveSkillBody(fixtureCwd, "scribe", pluginDirs);
    expect(body).toBeDefined();
    expect(body!.startsWith("---")).toBe(false);
    expect(body).toContain("Scribe");
  });

  test("accepts a namespaced ref (plugin:name) and resolves by name", async () => {
    expect(await resolveSkillBody(fixtureCwd, "gaas:scribe", pluginDirs)).toBeDefined();
  });

  test("returns undefined for an unknown skill", async () => {
    expect(await resolveSkillBody(fixtureCwd, "does-not-exist-xyz", pluginDirs)).toBeUndefined();
  });
});