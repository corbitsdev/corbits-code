import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIRECTOR_REGISTRY } from "./directors/registry.js";
import { DIRECTOR_IDS, type DirectorId } from "./directors/types.js";
import {
  assembleDirectorPrompt,
  canonicalToolNamesForDirector,
  directorPromptSizeTable,
  type PromptSizeFamily,
} from "./prompt-sizes.js";
import {
  advertisedToolNamesForSessionMode,
  CATALOG_TOOL_NAMES,
  CORE_TOOL_NAMES,
} from "./tool-search.js";
import { loadSessionChatPrompt } from "../session/runtime-assembly.js";
import { createAdvertisedToolset } from "../session/assemble-runtime.js";
import { resolveExecDirectorOverlay } from "../exec/runner.js";

/**
 * Prompt size budget (CL-7664). Numeric asserts only — copy edits must not
 * fail this test. Baselines are a checked-in snapshot of the max measured
 * sizes across all three families from the canonical fixture in
 * src/agent/prompt-sizes.ts; budgets add a +2000 char / +3000 byte allowance
 * (ceiling to 100) in code below. Bytes get the larger headroom because
 * multibyte copy can shift them faster. Adding a director is a type error
 * until its baseline lands here; growing a prompt past its allowance fails
 * until the baseline moves. Deliberate jumps above baseline + allowance
 * belong in PROMPT_SIZE_OVERRIDES with justification, not in the baseline.
 */
const PROMPT_SIZE_BASELINE: Record<
  DirectorId,
  { chars: number; bytes: number }
> = {
  dispatch: { chars: 6490, bytes: 6496 },
  explorer: { chars: 4041, bytes: 4059 },
  planner: { chars: 4439, bytes: 4447 },
  coder: { chars: 4705, bytes: 4715 },
  reviewer: { chars: 4625, bytes: 4635 },
  designer: { chars: 4596, bytes: 4604 },
  artist: { chars: 4285, bytes: 4293 },
  warden: { chars: 4113, bytes: 4127 },
  shakespeare: { chars: 5993, bytes: 6015 },
  prober: { chars: 5428, bytes: 5454 },
  "qa-lead": { chars: 5226, bytes: 5246 },
};

/**
 * Deliberate budgets above baseline + allowance, with justification.
 */
const PROMPT_SIZE_OVERRIDES: Partial<
  Record<DirectorId, { chars: number; bytes: number }>
> = {};

const CHAR_ALLOWANCE = 2000;
const BYTE_ALLOWANCE = 3000;

function ceil100(n: number): number {
  return Math.ceil(n / 100) * 100;
}

function budgetFor(directorId: DirectorId): { chars: number; bytes: number } {
  const override = PROMPT_SIZE_OVERRIDES[directorId];
  if (override !== undefined) return override;
  const base = PROMPT_SIZE_BASELINE[directorId];
  return {
    chars: ceil100(base.chars + CHAR_ALLOWANCE),
    bytes: ceil100(base.bytes + BYTE_ALLOWANCE),
  };
}

function budgetMessage(
  directorId: DirectorId,
  family: PromptSizeFamily,
  chars: number,
  bytes: number,
): string {
  const budget = budgetFor(directorId);
  return (
    `Director "${directorId}" [${family}]: ${chars} chars / ${bytes} bytes ` +
    `exceeds budget (${budget.chars} chars / ` +
    `${budget.bytes} bytes). Trim the prompt (preferred) or ` +
    `consciously raise the budget here with justification. ` +
    `Repro: bun -e 'import { directorPromptSizeTable } ` +
    `from "./src/agent/prompt-sizes.ts"; ` +
    `console.log(directorPromptSizeTable())'.`
  );
}

describe("director prompt size budget", () => {
  const rows = directorPromptSizeTable();

  test("covers every director in all five variance families", () => {
    expect(rows.length).toBe(DIRECTOR_IDS.length * 5);
    for (const directorId of DIRECTOR_IDS) {
      for (const family of [
        "default",
        "muse",
        "grok",
        "claude",
        "gpt",
      ] as const) {
        expect(
          rows.some((r) => r.directorId === directorId && r.family === family),
        ).toBe(true);
      }
    }
  });

  test("every assembled prompt stays within budget", () => {
    for (const row of rows) {
      const budget = budgetFor(row.directorId);
      const overChars = row.chars > budget.chars;
      const overBytes = row.bytes > budget.bytes;
      expect(
        overChars || overBytes,
        budgetMessage(row.directorId, row.family, row.chars, row.bytes),
      ).toBe(false);
    }
  });

  test("every assembled prompt is a real prompt, not an empty assembly", () => {
    for (const row of rows) {
      // CL-8212: lean workers legitimately assemble under 5000 chars (the
      // contract plus a short director body); the floor still catches an
      // empty assembly well below any real prompt.
      expect(row.chars).toBeGreaterThan(1000);
      expect(row.bytes).toBeGreaterThanOrEqual(row.chars);
    }
  });

  test("grok family never shrinks a prompt; only leaves grow", () => {
    for (const directorId of DIRECTOR_IDS) {
      const base = rows.find(
        (r) => r.directorId === directorId && r.family === "default",
      );
      const grok = rows.find(
        (r) => r.directorId === directorId && r.family === "grok",
      );
      expect(grok?.chars ?? 0).toBeGreaterThanOrEqual(base?.chars ?? 0);
      if (DIRECTOR_REGISTRY[directorId].spawn.maySpawn) {
        expect(grok?.chars).toBe(base?.chars);
      } else {
        expect(grok?.chars ?? 0).toBeGreaterThan(base?.chars ?? 0);
      }
    }
  });

  test("muse family grows the prompt (tool-discipline rules appended)", () => {
    for (const directorId of DIRECTOR_IDS) {
      const base = rows.find(
        (r) => r.directorId === directorId && r.family === "default",
      );
      const muse = rows.find(
        (r) => r.directorId === directorId && r.family === "muse",
      );
      expect(muse?.chars ?? 0).toBeGreaterThan(base?.chars ?? 0);
    }
  });

  test("claude leaves carry the XML task_guidance block exactly once", () => {
    for (const directorId of DIRECTOR_IDS) {
      const prompt = assembleDirectorPrompt(directorId, "claude");
      const occurrences = prompt.split("<task_guidance>").length - 1;
      if (DIRECTOR_REGISTRY[directorId].spawn.maySpawn) {
        expect(occurrences).toBe(0);
      } else {
        expect(occurrences).toBe(1);
        expect(prompt).toContain("</task_guidance>");
      }
    }
  });

  test("gpt directors carry the narrate-before-tools nudge exactly once", () => {
    for (const directorId of DIRECTOR_IDS) {
      const prompt = assembleDirectorPrompt(directorId, "gpt");
      const occurrences =
        prompt.split("Narrate before tools (GPT worker):").length - 1;
      expect(occurrences).toBe(1);
    }
  });

  test("default family carries no residual", () => {
    for (const directorId of DIRECTOR_IDS) {
      const prompt = assembleDirectorPrompt(directorId, "default");
      expect(prompt).not.toContain("<task_guidance>");
      expect(prompt).not.toContain("Narrate before tools (GPT worker):");
      expect(prompt).not.toContain("Tool budget:");
      expect(prompt).not.toContain("Finish bias (xAI / Grok worker):");
    }
  });

  test("tool names match the production mount: no dupes, no phantoms", () => {
    for (const directorId of DIRECTOR_IDS) {
      for (const family of [
        "default",
        "muse",
        "grok",
        "claude",
        "gpt",
      ] as const) {
        const names = canonicalToolNamesForDirector(
          DIRECTOR_REGISTRY[directorId],
          family,
        );
        expect(new Set(names).size, `${directorId} [${family}]`).toBe(
          names.length,
        );
        // Hidden Codex aliases (apply_patch/shell/update_plan) are not advertised,
        // as must list_dir, which no subagent mount installs.
        for (const phantom of [
          "list_dir",
          "apply_patch",
          "shell",
          "update_plan",
        ]) {
          expect(names, `${directorId} [${family}]`).not.toContain(phantom);
        }
        if (DIRECTOR_REGISTRY[directorId].spawn.maySpawn) {
          for (const verb of ["spawn_agent", "send_input"]) {
            expect(
              names.filter((n) => n === verb).length,
              `${directorId} [${family}] mounts ${verb} once`,
            ).toBe(1);
          }
        }
      }
    }
  });
});

describe("dispatch grok prefix (infer envelope vs trimmed director)", () => {
  // Production pin: a Grok fork at the runner that swapped loadSessionChatPrompt
  // or advertisedToolNamesForSessionMode for the trimmed director would fail here,
  // not only the fixture size inequality above.
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
