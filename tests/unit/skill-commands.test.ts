import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CommandContext } from "../../src/tui/commands/registry.js";
import { loadSkillCommands } from "../../src/plugins/skill-commands.js";
import { loadDataOnlyPlugin } from "../../src/plugins/data-only.js";

let root: string;

async function makePlugin(layout: Record<string, string>): Promise<string> {
  const dir = join(root, `p-${Math.random().toString(36).slice(2)}`);
  for (const [relPath, content] of Object.entries(layout)) {
    const fullPath = join(dir, relPath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
  return dir;
}

const ctx: CommandContext = { signalClear: () => {} };

beforeEach(async () => {
  root = await mkdtemp();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function mkdtemp(): Promise<string> {
  const dir = join(tmpdir(), `ic-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("loadSkillCommands", () => {
  test("returns null when there is no skills directory", async () => {
    const dir = await makePlugin({ "README.md": "hi" });
    expect(await loadSkillCommands(dir)).toBeNull();
  });

  test("promotes every skill to a slash command, tagged or not", async () => {
    const dir = await makePlugin({
      "skills/linear-issue-workflow/SKILL.md":
        "---\nname: linear-issue-workflow\ndescription: Implement a Linear issue\nargument-hint: \"<issue-id>\"\ndisable-model-invocation: true\n---\nImplement the issue.",
      "skills/linear-create/SKILL.md":
        "---\nname: linear-create\ndescription: Create Linear issues\n---\nCreate the artifacts.",
    });
    const cmds = await loadSkillCommands(dir);
    expect(cmds!.map((c) => c.name).sort()).toEqual(["linear-create", "linear-issue-workflow"]);

    // Tagged skill, no $ARGUMENTS in body -> args append.
    const workflow = cmds!.find((c) => c.name === "linear-issue-workflow")!;
    expect(workflow.description).toBe("Implement a Linear issue");
    expect(workflow.argumentHint).toBe("<issue-id>");
    expect(workflow.handler("ABC-123", ctx)).toEqual({
      type: "send",
      text: "Implement the issue.\n\nABC-123",
    });

    // Untagged skill still becomes a command.
    expect(cmds!.find((c) => c.name === "linear-create")).toBeDefined();
  });

  test("copies argument-hint from skill frontmatter", async () => {
    const dir = await makePlugin({
      "skills/linear-create/SKILL.md":
        "---\nname: linear-create\ndescription: Create Linear issues\nargument-hint: \"[description] [--from-doc]\"\n---\nCreate the artifacts.",
    });
    const cmd = (await loadSkillCommands(dir))!.find((c) => c.name === "linear-create")!;
    expect(cmd.argumentHint).toBe("[description] [--from-doc]");
  });


  test("$ARGUMENTS in a skill body interpolates inline", async () => {
    const dir = await makePlugin({
      "skills/hiring/SKILL.md":
        "---\nname: hiring\ndescription: Hiring\n---\nRun the loop on $ARGUMENTS.",
    });
    const cmd = (await loadSkillCommands(dir))!.find((c) => c.name === "hiring")!;
    expect(cmd.handler("analyze", ctx)).toEqual({ type: "send", text: "Run the loop on analyze." });
    expect(cmd.handler("", ctx)).toEqual({ type: "send", text: "Run the loop on ." });
  });

  test("falls back to the directory name when frontmatter omits name", async () => {
    const dir = await makePlugin({
      "skills/custom-name/SKILL.md": "---\ndescription: d\n---\nBody.",
    });
    const cmds = await loadSkillCommands(dir);
    expect(cmds!.map((c) => c.name)).toEqual(["custom-name"]);
  });
});

describe("loadDataOnlyPlugin — Claude marketplace adapter", () => {
  test(".claude-plugin/plugin.json provides id/name/description; kind inferred agent", async () => {
    const dir = await makePlugin({
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "gaas",
        description: "Dev skills and agents",
        version: "1.9.0",
      }),
      "agents/karen.md": "You orchestrate.",
      "skills/linear-create/SKILL.md": "---\nname: linear-create\n---\nDo it.",
      "skills/linear-issue-workflow/SKILL.md":
        "---\nname: linear-issue-workflow\ndisable-model-invocation: true\n---\nDo it.",
    });
    const plugin = await loadDataOnlyPlugin(dir);
    expect(plugin!.manifest).toEqual({
      id: "gaas",
      name: "gaas",
      kind: "agent",
      description: "Dev skills and agents",
    });
    // Agents wire (kind agent) AND every skill wires as a command.
    expect(plugin!.agentPlugin).toBeDefined();
    expect(plugin!.commandPlugin?.commands.map((c) => c.name).sort()).toEqual([
      "linear-create",
      "linear-issue-workflow",
    ]);
  });

  test("native manifest.json is preferred over .claude-plugin/plugin.json", async () => {
    const dir = await makePlugin({
      "manifest.json": JSON.stringify({ id: "native", name: "Native", kind: "agent" }),
      ".claude-plugin/plugin.json": JSON.stringify({ name: "claude-name", description: "ignored" }),
      "agents/karen.md": "You orchestrate.",
    });
    const plugin = await loadDataOnlyPlugin(dir);
    expect(plugin!.manifest.id).toBe("native");
    expect(plugin!.manifest.name).toBe("Native");
    expect(plugin!.manifest.description).toBeUndefined();
  });

  test("a skills-only plugin infers kind command (every skill is a command)", async () => {
    const dir = await makePlugin({
      "skills/hiring/SKILL.md": "---\nname: hiring\n---\nHire.",
      "skills/brand-identity/SKILL.md": "---\nname: brand-identity\n---\nBrand.",
    });
    const plugin = await loadDataOnlyPlugin(dir);
    expect(plugin!.manifest.kind).toBe("command");
    expect(plugin!.commandPlugin?.commands.map((c) => c.name).sort()).toEqual([
      "brand-identity",
      "hiring",
    ]);
    expect(plugin!.agentPlugin).toBeUndefined();
  });
});
