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

  test("returns null when no skill is tagged user-invocable", async () => {
    const dir = await makePlugin({
      "skills/plain/SKILL.md": "---\nname: plain\ndescription: d\n---\nBody.",
    });
    expect(await loadSkillCommands(dir)).toBeNull();
  });

  test("promotes a skill tagged disable-model-invocation: true", async () => {
    const dir = await makePlugin({
      "skills/linear-issue-workflow/SKILL.md":
        "---\nname: linear-issue-workflow\ndescription: Implement a Linear issue\nargument-hint: \"<issue-id>\"\ndisable-model-invocation: true\n---\nImplement the issue.",
    });
    const cmds = await loadSkillCommands(dir);
    expect(cmds).not.toBeNull();
    const cmd = cmds!.find((c) => c.name === "linear-issue-workflow");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toBe("Implement a Linear issue");
    // No $ARGUMENTS in body -> args append.
    expect(cmd!.handler("ABC-123", ctx)).toEqual({
      type: "send",
      text: "Implement the issue.\n\nABC-123",
    });
  });

  test("promotes a skill tagged user-invocable: true (Agent Skills spec)", async () => {
    const dir = await makePlugin({
      "skills/hiring/SKILL.md":
        "---\nname: hiring\ndescription: Hiring\nuser-invocable: true\n---\nRun the loop on $ARGUMENTS.",
    });
    const cmds = await loadSkillCommands(dir);
    expect(cmds!.find((c) => c.name === "hiring")).toBeDefined();
    const res = cmds!.find((c) => c.name === "hiring")!.handler("analyze", ctx);
    expect(res).toEqual({ type: "send", text: "Run the loop on analyze." });
  });

  test("only tagged skills become commands; untagged siblings are skipped", async () => {
    const dir = await makePlugin({
      "skills/tagged/SKILL.md": "---\nname: tagged\ndisable-model-invocation: true\n---\nT.",
      "skills/plain/SKILL.md": "---\nname: plain\n---\nP.",
    });
    const cmds = await loadSkillCommands(dir);
    expect(cmds!.map((c) => c.name)).toEqual(["tagged"]);
  });

  test("falls back to the directory name when frontmatter omits name", async () => {
    const dir = await makePlugin({
      "skills/custom-name/SKILL.md": "---\ndisable-model-invocation: true\ndescription: d\n---\nBody.",
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
    // Agents wire (kind agent) AND the tagged skill wires as a command.
    expect(plugin!.agentPlugin).toBeDefined();
    expect(plugin!.commandPlugin?.commands.map((c) => c.name)).toEqual(["linear-issue-workflow"]);
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

  test("a skills-only plugin with tagged skills infers kind command", async () => {
    const dir = await makePlugin({
      "skills/hiring/SKILL.md": "---\nname: hiring\nuser-invocable: true\n---\nHire.",
    });
    const plugin = await loadDataOnlyPlugin(dir);
    expect(plugin!.manifest.kind).toBe("command");
    expect(plugin!.commandPlugin?.commands.map((c) => c.name)).toEqual(["hiring"]);
    expect(plugin!.agentPlugin).toBeUndefined();
  });

  test("a skills-only plugin with no tagged skills is still loadable (enables use_skill)", async () => {
    const dir = await makePlugin({
      "skills/brand-identity/SKILL.md": "---\nname: brand-identity\ndescription: brand\n---\nBrand rules.",
    });
    const plugin = await loadDataOnlyPlugin(dir);
    expect(plugin).not.toBeNull();
    expect(plugin!.manifest.kind).toBe("agent");
    expect(plugin!.agentPlugin).toBeUndefined();
    expect(plugin!.commandPlugin).toBeUndefined();
  });
});
