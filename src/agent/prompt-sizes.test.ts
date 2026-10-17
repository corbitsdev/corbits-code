import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIRECTOR_REGISTRY } from "./directors/registry.js";
import {
  assembleDirectorPrompt,
  canonicalToolNamesForDirector,
} from "./prompt-sizes.js";
import {
  advertisedToolNamesForSessionMode,
  CATALOG_TOOL_NAMES,
  CORE_TOOL_NAMES,
} from "./tool-search.js";
import { loadSessionChatPrompt } from "../session/runtime-assembly.js";
import { createAdvertisedToolset } from "../session/assemble-runtime.js";
import { resolveExecDirectorOverlay } from "../exec/runner.js";

describe("dispatch grok prefix (infer envelope vs trimmed director)", () => {
  // Production pin: a Grok fork at the runner that swapped loadSessionChatPrompt
  // or advertisedToolNamesForSessionMode for the trimmed director would fail here.
  test("grok primary uses loadSessionChatPrompt and CORE+CATALOG, not the trimmed director", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "grok-primary-prefix-"));
    try {
      const agentsBody = "GROK_PRIMARY_KEEPS_AGENTS_MD\n";
      await writeFile(join(cwd, "AGENTS.md"), agentsBody);
      const availability = {
        languageServerAvailable: true,
        operatorAvailable: true,
        waitAgentsMounted: true,
      } as const;

      const { systemPrompt } = await loadSessionChatPrompt({
        cwd,
        skillDirs: [],
        sessionMode: "orchestrator",
        toolAvailability: availability,
        skills: [],
      });
      expect(systemPrompt).toContain(
        "## Project guidance (AGENTS.md, reference)",
      );
      expect(systemPrompt).toContain(agentsBody.trim());

      const trimmed = assembleDirectorPrompt("dispatch", "grok");
      expect(trimmed).not.toContain(
        "## Project guidance (AGENTS.md, reference)",
      );
      expect(trimmed).not.toContain(agentsBody.trim());

      const advertised = advertisedToolNamesForSessionMode(
        "orchestrator",
        availability,
      );
      expect(advertised).toEqual([...CORE_TOOL_NAMES, ...CATALOG_TOOL_NAMES]);
      const trimmedTools = canonicalToolNamesForDirector(
        DIRECTOR_REGISTRY.dispatch,
        "grok",
      );
      expect(trimmedTools).not.toContain("list_dir");
      expect(trimmedTools).not.toContain("tool_search");
      expect(trimmedTools).not.toContain("skill_search");

      const overlay = resolveExecDirectorOverlay("dispatch");
      expect(overlay.systemPrompt).toBeUndefined();
      expect(overlay.advertisedAllow).toBeUndefined();
      const { isAdvertised } = createAdvertisedToolset({
        sessionMode: "orchestrator",
        toolAvailability: availability,
        getProvider: () => ({ providerName: "xai/default", model: "grok-4.6" }),
        builtInPrefix: overlay.advertisedAllow,
      });
      for (const name of advertised) {
        expect(isAdvertised(name), name).toBe(true);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
