import { expect, test } from "bun:test";
import { join } from "node:path";

import { loadPluginEntry } from "../../src/plugins/loader.js";
import { resolveAgentPluginProfiles } from "../../src/plugins/agent-plugins.js";
import { buildSubAgentSystemPrompt } from "../../src/agent/prompts.js";


const pluginRoot = join(import.meta.dirname, "../../intercode-engineering-agents-plugin");

test("engineering-agents plugin loads profiles with expected ids", async () => {
  const mod = await loadPluginEntry(join(pluginRoot, "engineering-agents"));
  expect(mod).not.toBeNull();
  expect(mod!.manifest?.id).toBe("engineering-agents");
  expect(mod!.manifest?.kind).toBe("agent");

  const profiles = await resolveAgentPluginProfiles([mod!], {
    "engineering-agents": { enabled: true },
  });
  const ids = profiles.map((p) => p.id).sort();
  expect(ids).toEqual(["critique", "greybeard", "intern", "karen", "neckbeard"]);
  const karen = profiles.find((p) => p.id === "karen");
  expect(karen?.systemPromptRole).toContain("Bundled skill: dispatch");
  expect(karen?.systemPromptRole).toContain("Bundled skill: interview");
  const neck = profiles.find((p) => p.id === "neckbeard");
  expect(neck?.capabilities?.mode).toBe("allow");
  expect(neck?.capabilities?.tools).toContain("read_file");
  expect(neck?.capabilities?.tools).not.toContain("run_shell");
  expect(neck?.systemPromptRole).not.toContain("Intercode notes");
  // The appendix is appended at prompt-build time, so a dispatched neckbeard
  // still receives the Intercode translation notes.
  if (neck?.systemPromptRole === undefined) throw new Error("missing systemPromptRole");
  const prompt = buildSubAgentSystemPrompt([neck.systemPromptRole]);
  expect(prompt).toContain("Intercode notes");
});

