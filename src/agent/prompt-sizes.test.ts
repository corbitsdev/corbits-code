import { describe, expect, test } from "bun:test";
import { DIRECTOR_REGISTRY } from "./directors/registry.js";
import { DIRECTOR_IDS, type DirectorId } from "./directors/types.js";
import {
  canonicalToolNamesForDirector,
  directorPromptSizeTable,
  formatPromptSizeTable,
  type PromptSizeFamily,
} from "./prompt-sizes.js";

/**
 * Prompt size budget (CL-7664). Numeric asserts only — copy edits must not
 * fail this test. Baselines are a checked-in snapshot of the max measured
 * sizes across both families from the canonical fixture in
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
  skywalker: { chars: 24927, bytes: 25079 },
  builder: { chars: 47698, bytes: 47856 },
  explorer: { chars: 12197, bytes: 12259 },
  counsel: { chars: 50746, bytes: 50918 },
  intern: { chars: 14785, bytes: 14835 },
  critic: { chars: 52379, bytes: 52553 },
  greybeard: { chars: 51786, bytes: 51972 },
  neckbeard: { chars: 70280, bytes: 70468 },
  bruckheimer: { chars: 21273, bytes: 21369 },
  // CL-7809: includes the deliberate CL-7663 voice restore (PR #932).
  gaasbot: { chars: 52782, bytes: 52970 },
  draper: { chars: 13151, bytes: 13227 },
  emil: { chars: 14653, bytes: 14765 },
  rand: { chars: 13021, bytes: 13089 },
  shakespeare: { chars: 52774, bytes: 52956 },
  testsmith: { chars: 14193, bytes: 14269 },
  tester: { chars: 11975, bytes: 12033 },
};

/**
 * Deliberate budgets above baseline + allowance, with justification.
 * Empty on main: every current budget is exactly baseline + allowance.
 * (Wave 1: emil/draper growth and warden land here on rebase, not in main.)
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
    `Repro: bun -e 'import { directorPromptSizeTable, ` +
    `formatPromptSizeTable } from "./src/agent/prompt-sizes.ts"; ` +
    `console.log(formatPromptSizeTable(directorPromptSizeTable()))'.`
  );
}

describe("director prompt size budget", () => {
  const rows = directorPromptSizeTable();

  test("covers every director in both families", () => {
    expect(rows.length).toBe(DIRECTOR_IDS.length * 2);
    for (const directorId of DIRECTOR_IDS) {
      for (const family of ["default", "grok"] as const) {
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
      expect(row.chars).toBeGreaterThan(5000);
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

  test("measurement is deterministic", () => {
    const again = directorPromptSizeTable();
    expect(again.map((r) => r.chars)).toEqual(rows.map((r) => r.chars));
    expect(again.map((r) => r.bytes)).toEqual(rows.map((r) => r.bytes));
  });

  test("tool names match the production mount: no dupes, no phantoms", () => {
    for (const directorId of DIRECTOR_IDS) {
      for (const family of ["default", "grok"] as const) {
        const names = canonicalToolNamesForDirector(
          DIRECTOR_REGISTRY[directorId],
          family,
        );
        expect(new Set(names).size, `${directorId} [${family}]`).toBe(
          names.length,
        );
        // Neither fixture family is Codex, so the Codex proxies
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
      "| director | default chars (bytes) | grok chars (bytes) |",
    );
    for (const directorId of DIRECTOR_IDS) {
      const base = rows.find(
        (r) => r.directorId === directorId && r.family === "default",
      );
      const grok = rows.find(
        (r) => r.directorId === directorId && r.family === "grok",
      );
      expect(table).toContain(
        `| ${directorId} | ${base?.chars} (${base?.bytes}) | ${grok?.chars} (${grok?.bytes}) |`,
      );
    }
  });
});
