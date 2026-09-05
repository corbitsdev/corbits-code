import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { createSkillSearchTool, skillSearchDefinition } from "./skill-search.js";
import type { SkillSummary } from "../extensions/skills.js";

function call(
  tool: ReturnType<typeof createSkillSearchTool>,
  args: Record<string, unknown>,
): Promise<string> {
  if (tool.kind !== "string") throw new Error("expected string tool");
  return tool.handler(args, new AbortController().signal);
}

const roster: SkillSummary[] = [
  { name: "alpha-writer", description: "does other things" },
  { name: "beta", description: "writer for documents" },
  { name: "gamma", description: "unrelated capability" },
];

describe("skillSearchDefinition", () => {
  test("tells the model to look up details here and load bodies with use_skill", () => {
    expect(skillSearchDefinition.name).toBe("skill_search");
    expect(skillSearchDefinition.description).toContain("system prompt");
    expect(skillSearchDefinition.description).toContain("use_skill");
    expect(skillSearchDefinition.description).toMatch(/directly callable/i);
    expect(skillSearchDefinition.description).not.toMatch(/find this via tool_search/i);
  });
});

describe("createSkillSearchTool", () => {
  test("ranks a name-token match above a description-only match", async () => {
    const tool = createSkillSearchTool({ skills: roster });
    const out = await call(tool, { query: "writer" });
    const lines = out.split("\n").filter((line) => line.startsWith("- "));
    expect(lines[0]).toContain("alpha-writer");
    expect(out).toContain("beta");
    expect(out).not.toContain("does other things\nwriter");
  });

  test("rejects an empty query", async () => {
    const tool = createSkillSearchTool({ skills: roster });
    expect(await call(tool, { query: "   " })).toBe(
      "Error: skill_search requires a non-empty query.",
    );
  });

  test("returns a stable no-match string", async () => {
    const tool = createSkillSearchTool({ skills: roster });
    expect(await call(tool, { query: "qwerty-xyzzy-plugh" })).toBe(
      'No skills matched "qwerty-xyzzy-plugh". Try different keywords describing the capability.',
    );
  });

  test("empty catalog still returns the no-match string", async () => {
    const tool = createSkillSearchTool({ skills: [] });
    expect(await call(tool, { query: "anything" })).toBe(
      'No skills matched "anything". Try different keywords describing the capability.',
    );
  });

  test("caps results at 8", async () => {
    const skills = Array.from({ length: 12 }, (_, i) => ({
      name: `skill${i}`,
      description: "shared capability token",
    }));
    const tool = createSkillSearchTool({ skills });
    const out = await call(tool, { query: "capability" });
    const rows = out.split("\n").filter((line) => line.startsWith("- "));
    expect(rows).toHaveLength(8);
  });

  test("allowlist narrows the visible set", async () => {
    const tool = createSkillSearchTool({
      skills: roster,
      allowedNames: ["alpha-writer", "gamma"],
    });
    const out = await call(tool, { query: "writer" });
    expect(out).toContain("alpha-writer");
    expect(out).not.toContain("beta");
  });

  test("allowlist cannot widen to a declared-but-undiscovered name", async () => {
    const tool = createSkillSearchTool({
      skills: roster,
      allowedNames: ["alpha-writer", "ghost-skill"],
    });
    const out = await call(tool, { query: "ghost" });
    expect(out).toBe(
      'No skills matched "ghost". Try different keywords describing the capability.',
    );
    expect(out).not.toContain("ghost-skill");
  });

  test("result rows are name and description only — no body", async () => {
    const tool = createSkillSearchTool({
      skills: [{ name: "scribe", description: "write docs" }],
    });
    const out = await call(tool, { query: "scribe" });
    expect(out).toBe("- scribe: write docs");
    expect(out).not.toContain("input schema");
    expect(out).not.toContain("follow these instructions");
  });
});

describe("createAgentToolset skill_search mount", () => {
  test("advertises skill_search on the primary wire", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "corbits-skill-search-mount-"));
    const { createAgentToolset } = await import("./tools.js");
    const permissionGate = {
      check: async () => ({ allowed: true }),
      getSkipPermissions: () => false,
    } as never;
    const snapshot = [{ name: "scribe", description: "write docs" }];
    const toolset = await createAgentToolset({
      cwd,
      permissionGate,
      onOperatorGate: async () => ({ kind: "option", index: 0 }),
      skills: snapshot,
    });
    const names = toolset.dynamicRunner.currentDefinitions().map((d) => d.name);
    expect(names).toContain("skill_search");
    expect(names).toContain("use_skill");
    expect(toolset.skills).toEqual(snapshot);
    await toolset.dispose();
  });
});
