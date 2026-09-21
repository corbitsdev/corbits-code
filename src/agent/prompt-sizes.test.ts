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
  formatPromptSizeTable,
  formatSkywalkerPrefixTable,
  assembleSkywalkerInferEnvelope,
  measureSkywalkerPrefix,
  type PromptSizeFamily,
} from "./prompt-sizes.js";
import {
  advertisedToolNamesForSessionMode,
  CATALOG_TOOL_NAMES,
  CORE_TOOL_NAMES,
} from "./tool-search.js";
import { MAX_AGENTS_MD_BYTES } from "./context-extensions.js";
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
  // CL-8212: lean worker assembly [contract, tool-names-only, env, director
  // body, grok note] — no tool-catalog or appendix on the worker path.
  // Re-measured from the canonical fixture; grok family is the max for leaves.
  skywalker: { chars: 16494, bytes: 16604 },
  builder: { chars: 10344, bytes: 10382 },
  explorer: { chars: 4897, bytes: 4921 },
  counsel: { chars: 4816, bytes: 4834 },
  // Restore of gaas intern.md mechanical body; grok family is the max.
  intern: { chars: 7204, bytes: 7216 },
  critic: { chars: 6488, bytes: 6516 },
  greybeard: { chars: 5921, bytes: 5951 },
  neckbeard: { chars: 24256, bytes: 24290 },
  bruckheimer: { chars: 14160, bytes: 14220 },
  // CL-7809: includes the deliberate CL-7663 voice restore (PR #932).
  gaasbot: { chars: 6852, bytes: 6886 },
  // CL-8231: upstream router rewrite (skill-routed lenses, no hardcoded
  // Faremeter gates); re-measured from the canonical fixture.
  draper: { chars: 7726, bytes: 7766 },
  // CL-8234: upstream narrowed rewrite (eight principles + seven-law lens set,
  // tokens-only, fix direction); re-measured from the canonical fixture.
  emil: { chars: 8572, bytes: 8632 },
  rand: { chars: 5885, bytes: 5915 },
  shakespeare: { chars: 7008, bytes: 7036 },
  testsmith: { chars: 6788, bytes: 6828 },
  tester: { chars: 4675, bytes: 4695 },
  // CL-7658: grok family is the max; re-measured on rebase.
  gauntlet: { chars: 6535, bytes: 6559 },
  // CL-7656: grok family is the max; re-measured on rebase.
  prober: { chars: 6286, bytes: 6318 },
  // CL-7671 scope-honesty sentences; grok family is the max.
  migrator: { chars: 4449, bytes: 4469 },
  // CL-7657: grok family is the max; baseline + allowance covers it, so
  // main's tighter default-based budget needs no override.
  warden: { chars: 5487, bytes: 5511 },
};

/**
 * Deliberate budgets above baseline + allowance, with justification.
 * greybeard: the grok residual (tool budget + 8-line ceremony, folded into the
 * canonical promptResidual seam verbatim under CL-8296) plus the upstream
 * greybeard-package growth (#1121) pushed greybeard-grok to 8218 chars,
 * 218 over the 8000 baseline + allowance budget. Trimming the greybeard body
 * is greybeard-lane-owned, so the overage is budgeted here instead; bytes
 * stay at the current budget level (measured 8248 < 9000).
 */
const PROMPT_SIZE_OVERRIDES: Partial<
  Record<DirectorId, { chars: number; bytes: number }>
> = {
  greybeard: { chars: 8300, bytes: 9000 },
};

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
    `Repro: bun -e 'import { directorPromptSizeTable, ` +
    `formatPromptSizeTable } from "./src/agent/prompt-sizes.ts"; ` +
    `console.log(formatPromptSizeTable(directorPromptSizeTable()))'.`
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
      expect(row.chars).toBeGreaterThan(3000);
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

  test("muse family appends the shipped tool-discipline rules", () => {
    for (const directorId of DIRECTOR_IDS) {
      const base = rows.find(
        (r) => r.directorId === directorId && r.family === "default",
      );
      const muse = rows.find(
        (r) => r.directorId === directorId && r.family === "muse",
      );
      expect(muse?.chars ?? 0).toBeGreaterThan(base?.chars ?? 0);
      expect(assembleDirectorPrompt(directorId, "muse")).toContain(
        "Tool discipline:",
      );
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

  test("measurement is deterministic", () => {
    const again = directorPromptSizeTable();
    expect(again.map((r) => r.chars)).toEqual(rows.map((r) => r.chars));
    expect(again.map((r) => r.bytes)).toEqual(rows.map((r) => r.bytes));
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
        // No fixture family is Codex, so the Codex proxies
        // (createCodexToolProxies returns [] when !isCodex) must be absent,
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

  test("formatPromptSizeTable renders one row per director", () => {
    const table = formatPromptSizeTable(rows);
    expect(table).toContain(
      "| director | default chars (bytes) | muse chars (bytes) | grok chars (bytes) | claude chars (bytes) | gpt chars (bytes) |",
    );
    for (const directorId of DIRECTOR_IDS) {
      const base = rows.find(
        (r) => r.directorId === directorId && r.family === "default",
      );
      const muse = rows.find(
        (r) => r.directorId === directorId && r.family === "muse",
      );
      const grok = rows.find(
        (r) => r.directorId === directorId && r.family === "grok",
      );
      const claude = rows.find(
        (r) => r.directorId === directorId && r.family === "claude",
      );
      const gpt = rows.find(
        (r) => r.directorId === directorId && r.family === "gpt",
      );
      expect(table).toContain(
        `| ${directorId} | ${base?.chars} (${base?.bytes}) | ${muse?.chars} (${muse?.bytes}) | ${grok?.chars} (${grok?.bytes}) | ${claude?.chars} (${claude?.bytes}) | ${gpt?.chars} (${gpt?.bytes}) |`,
      );
    }
  });
});

describe("skywalker grok prefix (infer envelope vs trimmed director)", () => {
  test("keeps AGENTS.md and core tools on the infer envelope", () => {
    const prompt = assembleSkywalkerInferEnvelope();
    expect(prompt).toContain("## Project guidance (AGENTS.md, reference)");
    expect(prompt).toContain("Follow the repository conventions.");
    for (const name of CORE_TOOL_NAMES) {
      if (name === "wait_agents") continue;
      expect(prompt, name).toContain(`- ${name}:`);
    }
  });

  test("does not substitute the trimmed director prompt on grok", () => {
    const size = measureSkywalkerPrefix();
    expect(size.agentsMdCap).toBe(MAX_AGENTS_MD_BYTES);
    expect(size.inferEnvelopeChars).toBeGreaterThan(5000);
    expect(size.trimmedDirectorChars).toBeGreaterThan(5000);
    expect(size.inferEnvelopeBytes).toBeGreaterThanOrEqual(
      size.inferEnvelopeChars,
    );
    expect(size.inferEnvelopeChars).not.toBe(size.trimmedDirectorChars);
    const infer = assembleSkywalkerInferEnvelope();
    expect(infer).not.toContain("Finish bias (xAI / Grok worker):");
  });

  test("formatSkywalkerPrefixTable reports both prefixes and the AGENTS.md cap", () => {
    const size = measureSkywalkerPrefix();
    const table = formatSkywalkerPrefixTable(size);
    expect(table).toContain(
      `| skywalker infer envelope (canonical AGENTS.md) | ${size.inferEnvelopeChars} (${size.inferEnvelopeBytes}) |`,
    );
    expect(table).toContain(
      `| skywalker trimmed director (grok) | ${size.trimmedDirectorChars} (${size.trimmedDirectorBytes}) |`,
    );
    expect(table).toContain(`| live AGENTS.md cap | ${size.agentsMdCap} |`);
  });

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
      for (const name of CORE_TOOL_NAMES) {
        expect(systemPrompt, name).toContain(`- ${name}:`);
      }

      const trimmed = assembleDirectorPrompt("skywalker", "grok");
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
        DIRECTOR_REGISTRY.skywalker,
        "grok",
      );
      expect(trimmedTools).not.toContain("list_dir");
      expect(trimmedTools).not.toContain("tool_search");
      expect(trimmedTools).not.toContain("skill_search");

      const overlay = resolveExecDirectorOverlay("skywalker");
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

describe("grok tool-budget residual (CL-8297)", () => {
  const countOccurrences = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;

  test("a grok leaf director prompt contains the tool budget exactly once", () => {
    const prompt = assembleDirectorPrompt("builder", "grok");
    expect(countOccurrences(prompt, "Tool budget:")).toBe(1);
  });

  test("default-family and orchestrator prompts carry no tool budget", () => {
    const defaultPrompt = assembleDirectorPrompt("builder", "default");
    expect(defaultPrompt).not.toContain("Tool budget:");
    // The default probe resolves to the default family, so the default
    // column carries no family residual — neither the claude task_guidance
    // block nor the gpt narrate-before-tools nudge.
    expect(defaultPrompt).not.toContain("<task_guidance>");
    expect(defaultPrompt).not.toContain("Narrate before tools (GPT worker):");
    expect(assembleDirectorPrompt("skywalker", "grok")).not.toContain(
      "Tool budget:",
    );
  });
});
