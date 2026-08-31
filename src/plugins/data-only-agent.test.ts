import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { loadDataOnlyAgentPlugin } from "./data-only-agent.js";

test("legacy Task tool alias grants a collectable fleet surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "data-only-agent-task-alias-"));
  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(
    join(root, "agents", "delegate.md"),
    `---\nname: delegate\ndescription: delegate work\ntools:\n  - Task\n---\nDelegate work.\n`,
  );

  const plugin = await loadDataOnlyAgentPlugin(root, { cwd: root });
  const agent = plugin?.agentPlugin.agents[0] as
    { capabilities?: { mode: string; tools: string[] } } | undefined;

  expect(agent?.capabilities).toEqual({
    mode: "allow",
    tools: ["spawn_agent", "wait_agents"],
  });
});

test("legacy subagent tool alias grants a collectable fleet surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "data-only-agent-subagent-alias-"));
  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(
    join(root, "agents", "delegate.md"),
    `---\nname: delegate\ndescription: delegate work\ntools:\n  subagent: true\n---\nDelegate work.\n`,
  );

  const plugin = await loadDataOnlyAgentPlugin(root, { cwd: root });
  const agent = plugin?.agentPlugin.agents[0] as
    { capabilities?: { mode: string; tools: string[] } } | undefined;

  expect(agent?.capabilities).toEqual({
    mode: "allow",
    tools: ["spawn_agent", "wait_agents"],
  });
});
