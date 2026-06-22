import { expect, test } from "bun:test";
import { join } from "node:path";

import { formatSkillDirective, resolveSkillBody } from "../../src/extensions/skills.js";

const repoRoot = join(import.meta.dirname, "../..");

test("resolveSkillBody loads bundled gaas:scribe skill", async () => {
  const body = await resolveSkillBody(repoRoot, "gaas:scribe");
  expect(body).toBeDefined();
  expect(body).toContain("PRODUCT");
  expect(body).toContain("ARCHITECTURE");
});

test("formatSkillDirective wraps body with a header", () => {
  const formatted = formatSkillDirective("gaas:scribe", "hello");
  expect(formatted).toContain("[Skill: gaas:scribe]");
  expect(formatted).toContain("hello");
});