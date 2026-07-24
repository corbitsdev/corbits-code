import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadDataOnlyAgentPlugin } from "../../src/plugins/data-only-agent.js";

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

describe("loadDataOnlyAgentPlugin", () => {
  test("returns null when there are no *.md files (neither in agents/ nor at root)", async () => {
    const dir = await makePlugin({ "README": "hi", "notes.txt": "no" });
    const plugin = await loadDataOnlyAgentPlugin(dir, { pluginId: "x" });
    expect(plugin).toBeNull();
  });

  test("returns null when agents/ is empty", async () => {
    const dir = await makePlugin({});
    const plugin = await loadDataOnlyAgentPlugin(dir, { pluginId: "x" });
    expect(plugin).toBeNull();
  });

  test("synthesizes a profile from a markdown file with no frontmatter", async () => {
    const dir = await makePlugin({
      "agents/karen.md": "You orchestrate.\n",
    });
    const plugin = await loadDataOnlyAgentPlugin(dir, { pluginId: "team" });
    expect(plugin).not.toBeNull();
    expect(plugin!.manifest).toEqual({
      id: "team",
      name: "team",
      kind: "agent",
    });
    expect(plugin!.agentPlugin.agents.length).toBe(1);
    const agent = plugin!.agentPlugin.agents[0] as { id: string; systemPromptRole: string };
    expect(agent.id).toBe("karen");
    expect(agent.systemPromptRole).toContain("You orchestrate.");
    // The Intercode appendix is appended at prompt-build time by
    // buildSubAgentSystemPrompt, not stored on the profile.
    expect(agent.systemPromptRole).not.toContain("Intercode notes");
  });

  test("uses frontmatter name when id is absent", async () => {
    const dir = await makePlugin({
      "agents/foo.md": "---\nname: bar\ndescription: d\n---\nbody\n",
    });
    const plugin = await loadDataOnlyAgentPlugin(dir, { pluginId: "p" });
    const agent = plugin!.agentPlugin.agents[0] as { id: string; description?: string };
    expect(agent.id).toBe("bar");
    expect(agent.description).toBe("d");
  });

  test("accepts corbitsdev permission shape (flat allow/deny)", async () => {
    const dir = await makePlugin({
      "agents/neckbeard.md":
        "---\nname: neckbeard\nmode: subagent\npermission:\n  read: allow\n  glob: allow\n  grep: allow\n  bash: deny\n  write: deny\n  edit: deny\n---\nbody\n",
    });
    const plugin = await loadDataOnlyAgentPlugin(dir, { pluginId: "p" });
    const agent = plugin!.agentPlugin.agents[0] as {
      capabilities?: { mode: string; tools: string[] };
    };
    expect(agent.capabilities).toBeDefined();
    // No wildcard deny, both allowed and denied lists non-empty — shorter wins.
    // allowed=3, denied=3 — pick exclude (smaller-or-equal rule).
    expect(agent.capabilities!.mode).toBe("exclude");
    expect(agent.capabilities!.tools.sort()).toEqual(["edit_file", "run_shell", "write_file"]);
  });

  test("mode: primary with all-allow permission = no restriction", async () => {
    const dir = await makePlugin({
      "agents/karen.md":
        "---\nname: karen\nmode: primary\npermission:\n  read: allow\n  bash: allow\n---\nbody\n",
    });
    const plugin = await loadDataOnlyAgentPlugin(dir, { pluginId: "p" });
    const agent = plugin!.agentPlugin.agents[0] as { capabilities?: unknown };
    expect(agent.capabilities).toBeUndefined();
  });

  test("Claude Code tools[] allowlist is aliased to Intercode tool names", async () => {
    const dir = await makePlugin({
      "agents/scout.md":
        "---\nname: scout\ntools: [Read, Grep, Glob, Bash]\n---\nbody\n",
    });
    const plugin = await loadDataOnlyAgentPlugin(dir, { pluginId: "p" });
    const agent = plugin!.agentPlugin.agents[0] as {
      capabilities?: { mode: string; tools: string[] };
    };
    expect(agent.capabilities!.mode).toBe("allow");
    expect(agent.capabilities!.tools.sort()).toEqual([
      "grep",
      "read_file",
      "run_shell",
      "search_files",
    ]);
  });

  test("Claude Code disallowedTools produces exclude mode", async () => {
    const dir = await makePlugin({
      "agents/w.md":
        "---\nname: w\ndisallowedTools: [Bash, Write, Edit]\n---\nbody\n",
    });
    const plugin = await loadDataOnlyAgentPlugin(dir, { pluginId: "p" });
    const agent = plugin!.agentPlugin.agents[0] as {
      capabilities?: { mode: string; tools: string[] };
    };
    expect(agent.capabilities!.mode).toBe("exclude");
    expect(agent.capabilities!.tools.sort()).toEqual(["edit_file", "run_shell", "write_file"]);
  });

  test("OpenCode nested permission with wildcard deny becomes allowlist", async () => {
    const dir = await makePlugin({
      "agents/r.md":
        "---\nname: r\npermission:\n  tool:\n    \"*\": deny\n    read: allow\n    grep: allow\n---\nbody\n",
    });
    const plugin = await loadDataOnlyAgentPlugin(dir, { pluginId: "p" });
    const agent = plugin!.agentPlugin.agents[0] as {
      capabilities?: { mode: string; tools: string[] };
    };
    expect(agent.capabilities!.mode).toBe("allow");
    expect(agent.capabilities!.tools.sort()).toEqual(["grep", "read_file"]);
  });

  test("OpenCode legacy tools: {read: true, bash: false} mixed picks shorter", async () => {
    const dir = await makePlugin({
      "agents/m.md":
        "---\nname: m\ntools:\n  read: true\n  grep: true\n  bash: false\n---\nbody\n",
    });
    const plugin = await loadDataOnlyAgentPlugin(dir, { pluginId: "p" });
    const agent = plugin!.agentPlugin.agents[0] as {
      capabilities?: { mode: string; tools: string[] };
    };
    // 1 false vs 2 true — exclude wins.
    expect(agent.capabilities!.mode).toBe("exclude");
    expect(agent.capabilities!.tools).toEqual(["run_shell"]);
  });

  test("tier alias is accepted", async () => {
    const dir = await makePlugin({
      "agents/a.md": "---\ntier: clever\n---\nbody\n",
    });
    const plugin = await loadDataOnlyAgentPlugin(dir, { pluginId: "p" });
    const agent = plugin!.agentPlugin.agents[0] as { tier?: string };
    expect(agent.tier).toBe("clever");
  });

  test("Claude Code effort:high maps to tier clever", async () => {
    const dir = await makePlugin({
      "agents/a.md": "---\neffort: high\n---\nbody\n",
    });
    const plugin = await loadDataOnlyAgentPlugin(dir, { pluginId: "p" });
    const agent = plugin!.agentPlugin.agents[0] as { tier?: string };
    expect(agent.tier).toBe("clever");
  });

  test("native inference block (single leg) is accepted", async () => {
    const dir = await makePlugin({
      "agents/a.md":
        "---\ninference:\n  order:\n    - { provider: anthropic, model: claude-sonnet-4, reasoningEffort: medium }\n---\nbody\n",
    });
    const plugin = await loadDataOnlyAgentPlugin(dir, { pluginId: "p" });
    const agent = plugin!.agentPlugin.agents[0] as {
      inference?: { mode?: string; order: { provider: string; model: string; reasoningEffort?: string }[] };
    };
    expect(agent.inference).toBeDefined();
    expect(agent.inference!.mode).toBe("prefer");
    expect(agent.inference!.order[0]).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4",
      reasoningEffort: "medium",
    });
  });

  test("native inference block drops a leg missing model but keeps the valid ones", async () => {
    const dir = await makePlugin({
      "agents/a.md":
        "---\ninference:\n  order:\n    - { provider: anthropic, model: claude-sonnet-4 }\n    - { provider: xai }\n---\nbody\n",
    });
    const plugin = await loadDataOnlyAgentPlugin(dir, { pluginId: "p" });
    const agent = plugin!.agentPlugin.agents[0] as {
      inference?: { order: { provider: string; model: string }[] };
    };
    expect(agent.inference!.order).toHaveLength(1);
    expect(agent.inference!.order[0]).toEqual({ provider: "anthropic", model: "claude-sonnet-4" });
  });

  test("native capabilities block with a non-boolean mode falls through instead of restricting", async () => {
    const dir = await makePlugin({
      "agents/a.md": "---\ncapabilities:\n  mode: sometimes\n  tools: [read_file]\n---\nbody\n",
    });
    const plugin = await loadDataOnlyAgentPlugin(dir, { pluginId: "p" });
    const agent = plugin!.agentPlugin.agents[0] as { capabilities?: unknown };
    expect(agent.capabilities).toBeUndefined();
  });

  test("model: array becomes a prefer chain", async () => {
    const dir = await makePlugin({
      "agents/a.md":
        "---\nmodel:\n  - { provider: anthropic, model: claude-sonnet-4 }\n  - { provider: xai, model: grok-4 }\n---\nbody\n",
    });
    const plugin = await loadDataOnlyAgentPlugin(dir, { pluginId: "p" });
    const agent = plugin!.agentPlugin.agents[0] as {
      inference?: { mode?: string; order: { provider: string; model: string }[] };
    };
    expect(agent.inference!.order.length).toBe(2);
    expect(agent.inference!.order[0]!.provider).toBe("anthropic");
    expect(agent.inference!.order[1]!.provider).toBe("xai");
  });

  test("frontmatter skills list bundles skill text into the prompt", async () => {
    const dir = await makePlugin({
      "agents/a.md": "---\nskills: [style]\n---\nagent body\n",
      "skills/style/SKILL.md": "---\nname: style\n---\nBe clean.\n",
    });
    const plugin = await loadDataOnlyAgentPlugin(dir, { pluginId: "p" });
    const agent = plugin!.agentPlugin.agents[0] as { systemPromptRole: string };
    expect(agent.systemPromptRole).toContain("Bundled skill: style");
    expect(agent.systemPromptRole).toContain("Be clean.");
    expect(agent.systemPromptRole).toContain("agent body");
  });

  test("body 'Load the `X` skill' lines are auto-detected", async () => {
    const dir = await makePlugin({
      "agents/a.md":
        "Session init:\n2. Load the `style` skill\n3. Load the `philosophy` skill\n\nbody\n",
      "skills/style/SKILL.md": "Be clean.",
      "skills/philosophy/SKILL.md": "Be principled.",
    });
    const plugin = await loadDataOnlyAgentPlugin(dir, { pluginId: "p" });
    const agent = plugin!.agentPlugin.agents[0] as { systemPromptRole: string };
    expect(agent.systemPromptRole).toContain("Bundled skill: style");
    expect(agent.systemPromptRole).toContain("Bundled skill: philosophy");
  });

  test("missing skill triggers warning but does not fail load", async () => {
    const dir = await makePlugin({
      "agents/a.md": "---\nskills: [nope]\n---\nbody\n",
    });
    const warnings: string[] = [];
    const plugin = await loadDataOnlyAgentPlugin(dir, {
      pluginId: "p",
      onWarning: (m) => warnings.push(m),
    });
    expect(plugin).not.toBeNull();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('"nope"');
  });

  test("malformed frontmatter is skipped, others load", async () => {
    const dir = await makePlugin({
      "agents/good.md": "---\nname: good\n---\nbody\n",
      "agents/bad.md": "this has no frontmatter at all but is valid markdown\n",
    });
    const warnings: string[] = [];
    const plugin = await loadDataOnlyAgentPlugin(dir, {
      pluginId: "p",
      onWarning: (m) => warnings.push(m),
    });
    // Both load — no-frontmatter is acceptable (synthesized from body alone).
    expect(plugin!.agentPlugin.agents.length).toBe(2);
    expect(warnings.length).toBe(0);
  });

  test("pluginId defaults to directory basename", async () => {
    const dir = await makePlugin({
      "agents/a.md": "body\n",
    });
    const plugin = await loadDataOnlyAgentPlugin(dir);
    const expected = dir.split("/").pop() as string;
    expect(plugin).not.toBeNull();
    expect(plugin!.manifest.id).toBe(expected);
  });

  test("loads agents directly in the plugin dir (no agents/ subfolder)", async () => {
    const dir = await makePlugin({
      "alpha.md": "---\nid: alpha\ndescription: direct\n---\nDirect agent body",
    });
    const plugin = await loadDataOnlyAgentPlugin(dir, { pluginId: "flat" });
    expect(plugin).not.toBeNull();
    expect(plugin!.manifest.id).toBe("flat");
    expect(plugin!.agentPlugin.agents.length).toBe(1);
    expect((plugin!.agentPlugin.agents[0] as any).id).toBe("alpha");
    expect((plugin!.agentPlugin.agents[0] as any).systemPromptRole).toContain("Direct agent body");
  });

  test("supports pointing at agents/ subdir directly; id comes from parent; skills resolve from sibling", async () => {
    const dir = await makePlugin({
      "agents/beta.md": "---\nname: beta\n---\nLoad the `style` skill\n\nbeta body here",
      "skills/style/SKILL.md": "Style rules: be concise.",
    });
    const agentsSub = join(dir, "agents");
    const plugin = await loadDataOnlyAgentPlugin(agentsSub);
    expect(plugin).not.toBeNull();
    // id derives from parent dir name, not "agents"
    const expectedId = dir.split("/").pop() as string;
    expect(plugin!.manifest.id).toBe(expectedId);
    expect(plugin!.agentPlugin.agents.length).toBe(1);
    const prof = plugin!.agentPlugin.agents[0] as any;
    expect(prof.id).toBe("beta");
    expect(prof.systemPromptRole).toContain("Bundled skill: style");
    expect(prof.systemPromptRole).toContain("Style rules: be concise.");
    expect(prof.systemPromptRole).toContain("beta body here");
  });
});
