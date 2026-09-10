import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type } from "arktype";
import { loadDataOnlyAgentPlugin } from "../../src/plugins/data-only-agent.js";
import type { DataOnlyAgentPlugin } from "../../src/plugins/data-only-agent.js";
import { AgentProfileSchema } from "../../src/agent/profiles.js";
import type {
  CapabilityFilter,
  InferenceLeg,
  InferenceSpec,
} from "../../src/agent/profile-types.js";
import { defined } from "../helpers/defined.js";

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
  const dir = join(
    tmpdir(),
    `ic-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

function firstAgent(plugin: DataOnlyAgentPlugin) {
  const parsed = AgentProfileSchema(
    defined(plugin.agentPlugin.agents[0], "agent"),
  );
  if (parsed instanceof type.errors) {
    throw new Error(
      `expected agent to match AgentProfileSchema: ${parsed.summary}`,
    );
  }
  return parsed;
}

describe("loadDataOnlyAgentPlugin", () => {
  test("returns null when there are no *.md files (neither in agents/ nor at root)", async () => {
    const dir = await makePlugin({ README: "hi", "notes.txt": "no" });
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
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, { pluginId: "team" }),
      "plugin",
    );
    expect(plugin.manifest).toEqual({
      id: "team",
      name: "team",
      kind: "agent",
    });
    expect(plugin.agentPlugin.agents.length).toBe(1);
    const agent = firstAgent(plugin);
    expect(agent.id).toBe("karen");
    expect(agent.systemPromptRole).toContain("You orchestrate.");
    // The Corbits Code appendix is appended at prompt-build time by
    // buildSubAgentSystemPrompt, not stored on the profile.
    expect(agent.systemPromptRole).not.toContain("Corbits Code notes");
  });

  test("uses frontmatter name when id is absent", async () => {
    const dir = await makePlugin({
      "agents/foo.md": "---\nname: bar\ndescription: d\n---\nbody\n",
    });
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, { pluginId: "p" }),
      "plugin",
    );
    const agent = firstAgent(plugin);
    expect(agent.id).toBe("bar");
    expect(agent.description).toBe("d");
  });

  test("accepts corbitsdev permission shape (flat allow/deny)", async () => {
    const dir = await makePlugin({
      "agents/neckbeard.md":
        "---\nname: neckbeard\nmode: subagent\npermission:\n  read: allow\n  glob: allow\n  grep: allow\n  bash: deny\n  write: deny\n  edit: deny\n---\nbody\n",
    });
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, { pluginId: "p" }),
      "plugin",
    );
    const agent = firstAgent(plugin);
    const capabilities = defined<CapabilityFilter>(
      agent.capabilities,
      "capabilities",
    );
    // No wildcard deny, both allowed and denied lists non-empty — shorter wins.
    // allowed=3, denied=3 — pick exclude (smaller-or-equal rule).
    expect(capabilities.mode).toBe("exclude");
    expect(capabilities.tools.sort()).toEqual([
      "edit_file",
      "run_shell",
      "write_file",
    ]);
  });

  test("mode: primary with all-allow permission = no restriction", async () => {
    const dir = await makePlugin({
      "agents/karen.md":
        "---\nname: karen\nmode: primary\npermission:\n  read: allow\n  bash: allow\n---\nbody\n",
    });
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, { pluginId: "p" }),
      "plugin",
    );
    const agent = firstAgent(plugin);
    expect(agent.capabilities).toBeUndefined();
  });

  test("Claude Code tools[] allowlist is aliased to Corbits Code tool names", async () => {
    const dir = await makePlugin({
      "agents/scout.md":
        "---\nname: scout\ntools: [Read, Grep, Glob, Bash]\n---\nbody\n",
    });
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, { pluginId: "p" }),
      "plugin",
    );
    const capabilities = defined<CapabilityFilter>(
      firstAgent(plugin).capabilities,
      "capabilities",
    );
    expect(capabilities.mode).toBe("allow");
    expect(capabilities.tools.sort()).toEqual([
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
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, { pluginId: "p" }),
      "plugin",
    );
    const capabilities = defined<CapabilityFilter>(
      firstAgent(plugin).capabilities,
      "capabilities",
    );
    expect(capabilities.mode).toBe("exclude");
    expect(capabilities.tools.sort()).toEqual([
      "edit_file",
      "run_shell",
      "write_file",
    ]);
  });

  test("OpenCode nested permission with wildcard deny becomes allowlist", async () => {
    const dir = await makePlugin({
      "agents/r.md":
        '---\nname: r\npermission:\n  tool:\n    "*": deny\n    read: allow\n    grep: allow\n---\nbody\n',
    });
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, { pluginId: "p" }),
      "plugin",
    );
    const capabilities = defined<CapabilityFilter>(
      firstAgent(plugin).capabilities,
      "capabilities",
    );
    expect(capabilities.mode).toBe("allow");
    expect(capabilities.tools.sort()).toEqual(["grep", "read_file"]);
  });

  test("OpenCode legacy tools: {read: true, bash: false} mixed picks shorter", async () => {
    const dir = await makePlugin({
      "agents/m.md":
        "---\nname: m\ntools:\n  read: true\n  grep: true\n  bash: false\n---\nbody\n",
    });
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, { pluginId: "p" }),
      "plugin",
    );
    const capabilities = defined<CapabilityFilter>(
      firstAgent(plugin).capabilities,
      "capabilities",
    );
    // 1 false vs 2 true — exclude wins.
    expect(capabilities.mode).toBe("exclude");
    expect(capabilities.tools).toEqual(["run_shell"]);
  });

  test("bare tier frontmatter is ignored (tiers were removed)", async () => {
    const dir = await makePlugin({
      "agents/a.md": "---\ntier: clever\n---\nbody\n",
    });
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, { pluginId: "p" }),
      "plugin",
    );
    const agent = firstAgent(plugin);
    expect(agent.inference).toBeUndefined();
  });

  test("bare Claude Code effort:high is ignored without a model to attach it to", async () => {
    const dir = await makePlugin({
      "agents/a.md": "---\neffort: high\n---\nbody\n",
    });
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, { pluginId: "p" }),
      "plugin",
    );
    const agent = firstAgent(plugin);
    expect(agent.inference).toBeUndefined();
  });

  test("native inference block (single leg) is accepted", async () => {
    const dir = await makePlugin({
      "agents/a.md":
        "---\ninference:\n  order:\n    - { provider: anthropic, model: claude-sonnet-4, reasoningEffort: medium }\n---\nbody\n",
    });
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, { pluginId: "p" }),
      "plugin",
    );
    const inference = defined<InferenceSpec>(
      firstAgent(plugin).inference,
      "inference",
    );
    expect(inference.mode).toBe("prefer");
    expect(inference.order[0]).toEqual({
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
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, { pluginId: "p" }),
      "plugin",
    );
    const inference = defined<InferenceSpec>(
      firstAgent(plugin).inference,
      "inference",
    );
    expect(inference.order).toHaveLength(1);
    expect(inference.order[0]).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
  });

  test("native capabilities block with a non-boolean mode falls through instead of restricting", async () => {
    const dir = await makePlugin({
      "agents/a.md":
        "---\ncapabilities:\n  mode: sometimes\n  tools: [read_file]\n---\nbody\n",
    });
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, { pluginId: "p" }),
      "plugin",
    );
    const agent = firstAgent(plugin);
    expect(agent.capabilities).toBeUndefined();
  });

  test("native capabilities block with a non-string tools entry restricts rather than granting unrestricted access", async () => {
    const dir = await makePlugin({
      "agents/a.md":
        "---\ncapabilities:\n  mode: allow\n  tools: [read_file, 42, grep]\n---\nbody\n",
    });
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, { pluginId: "p" }),
      "plugin",
    );
    const capabilities = defined<CapabilityFilter>(
      firstAgent(plugin).capabilities,
      "capabilities",
    );
    expect(capabilities.mode).toBe("allow");
    expect(capabilities.tools.sort()).toEqual(["grep", "read_file"]);
  });

  test("model: array becomes a prefer chain", async () => {
    const dir = await makePlugin({
      "agents/a.md":
        "---\nmodel:\n  - { provider: anthropic, model: claude-sonnet-4 }\n  - { provider: xai, model: grok-4 }\n---\nbody\n",
    });
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, { pluginId: "p" }),
      "plugin",
    );
    const inference = defined<InferenceSpec>(
      firstAgent(plugin).inference,
      "inference",
    );
    expect(inference.order.length).toBe(2);
    expect(
      defined<InferenceLeg>(inference.order[0], "first inference leg").provider,
    ).toBe("anthropic");
    expect(
      defined<InferenceLeg>(inference.order[1], "second inference leg")
        .provider,
    ).toBe("xai");
  });

  test("frontmatter skills list bundles skill text into the prompt", async () => {
    const dir = await makePlugin({
      "agents/a.md": "---\nskills: [style]\n---\nagent body\n",
      "skills/style/SKILL.md": "---\nname: style\n---\nBe clean.\n",
    });
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, { pluginId: "p" }),
      "plugin",
    );
    const agent = firstAgent(plugin);
    expect(agent.systemPromptRole).toContain("Bundled skill: style");
    expect(agent.systemPromptRole).toContain("Be clean.");
    expect(agent.systemPromptRole).toContain("agent body");
  });

  test("frontmatter relative skill path bundles under plugin root", async () => {
    const dir = await makePlugin({
      "agents/a.md": '---\nskills: ["./skills/style"]\n---\nagent body\n',
      "skills/style/SKILL.md": "---\nname: style\n---\nRelative clean.\n",
    });
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, { pluginId: "p" }),
      "plugin",
    );
    const agent = firstAgent(plugin);
    expect(agent.systemPromptRole).toContain("Bundled skill: ./skills/style");
    expect(agent.systemPromptRole).toContain("Relative clean.");
  });

  test("frontmatter absolute skill path is rejected", async () => {
    const dir = await makePlugin({
      "agents/a.md": "---\nskills: [/etc/passwd]\n---\nbody\n",
    });
    const warnings: string[] = [];
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, {
        pluginId: "p",
        onWarning: (m) => warnings.push(m),
      }),
      "plugin",
    );
    const agent = firstAgent(plugin);
    expect(agent.systemPromptRole).not.toContain("Bundled skill");
    expect(warnings.some((w) => w.includes("/etc/passwd"))).toBe(true);
  });

  test("body 'Load the `X` skill' lines are auto-detected", async () => {
    const dir = await makePlugin({
      "agents/a.md":
        "Session init:\n2. Load the `style` skill\n3. Load the `philosophy` skill\n\nbody\n",
      "skills/style/SKILL.md": "Be clean.",
      "skills/philosophy/SKILL.md": "Be principled.",
    });
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, { pluginId: "p" }),
      "plugin",
    );
    const agent = firstAgent(plugin);
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
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, {
        pluginId: "p",
        onWarning: (m) => warnings.push(m),
      }),
      "plugin",
    );
    // Both load — no-frontmatter is acceptable (synthesized from body alone).
    expect(plugin.agentPlugin.agents.length).toBe(2);
    expect(warnings.length).toBe(0);
  });

  test("pluginId defaults to directory basename", async () => {
    const dir = await makePlugin({
      "agents/a.md": "body\n",
    });
    const plugin = defined(await loadDataOnlyAgentPlugin(dir), "plugin");
    const expected = defined(dir.split("/").pop(), "plugin id");
    expect(plugin.manifest.id).toBe(expected);
  });

  test("loads agents directly in the plugin dir (no agents/ subfolder)", async () => {
    const dir = await makePlugin({
      "alpha.md": "---\nid: alpha\ndescription: direct\n---\nDirect agent body",
    });
    const plugin = defined(
      await loadDataOnlyAgentPlugin(dir, { pluginId: "flat" }),
      "plugin",
    );
    expect(plugin.manifest.id).toBe("flat");
    expect(plugin.agentPlugin.agents.length).toBe(1);
    const agent = firstAgent(plugin);
    expect(agent.id).toBe("alpha");
    expect(agent.systemPromptRole).toContain("Direct agent body");
  });

  test("supports pointing at agents/ subdir directly; id comes from parent; skills resolve from sibling", async () => {
    const dir = await makePlugin({
      "agents/beta.md":
        "---\nname: beta\n---\nLoad the `style` skill\n\nbeta body here",
      "skills/style/SKILL.md": "Style rules: be concise.",
    });
    const agentsSub = join(dir, "agents");
    const plugin = defined(await loadDataOnlyAgentPlugin(agentsSub), "plugin");
    // id derives from parent dir name, not "agents"
    const expectedId = defined(dir.split("/").pop(), "plugin id");
    expect(plugin.manifest.id).toBe(expectedId);
    expect(plugin.agentPlugin.agents.length).toBe(1);
    const prof = firstAgent(plugin);
    expect(prof.id).toBe("beta");
    expect(prof.systemPromptRole).toContain("Bundled skill: style");
    expect(prof.systemPromptRole).toContain("Style rules: be concise.");
    expect(prof.systemPromptRole).toContain("beta body here");
  });
});
