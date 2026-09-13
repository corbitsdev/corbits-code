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
 * fail this test. Baselines were captured from the canonical fixture in
 * src/agent/prompt-sizes.ts with a +2000 char / +3000 byte allowance; bytes
 * get the larger headroom because multibyte copy can shift them faster.
 */
const CHAR_BUDGET: Record<DirectorId, number> = {
  skywalker: 27000,
  builder: 48800,
  explorer: 14200,
  counsel: 52700,
  intern: 16800,
  critic: 54400,
  greybeard: 53600,
  neckbeard: 72300,
  bruckheimer: 23200,
  // CL-7809: deliberate CL-7663 voice restore (PR #932) grew gaasbot to
  // 52782 chars; budget = measured + 2000 allowance, ceiling to 100.
  gaasbot: 54800,
  draper: 15100,
  emil: 16600,
  rand: 15000,
  shakespeare: 54700,
  testsmith: 16200,
  tester: 13900,
  // CL-7671 scope-honesty sentences grew migrator past the 12300-char
  // placeholder: measured-max (11202) + 2000 allowance, ceiling to 100.
  migrator: 13300,
};

const BYTE_BUDGET: Record<DirectorId, number> = {
  skywalker: 28100,
  builder: 50000,
  explorer: 15200,
  counsel: 53900,
  intern: 17800,
  critic: 55500,
  greybeard: 54800,
  neckbeard: 73400,
  bruckheimer: 24300,
  // CL-7809: deliberate CL-7663 voice restore (PR #932) grew gaasbot to
  // 52970 bytes; budget = measured + 3000 allowance, ceiling to 100.
  gaasbot: 56000,
  draper: 16200,
  emil: 17700,
  rand: 16100,
  shakespeare: 55900,
  testsmith: 17200,
  tester: 15000,
  // CL-7671 scope-honesty sentences grew migrator past the 13400-byte
  // placeholder: measured-max (11258) + 3000 allowance, ceiling to 100.
  migrator: 14300,
};

function budgetMessage(
  directorId: DirectorId,
  family: PromptSizeFamily,
  chars: number,
  bytes: number,
): string {
  return (
    `Director "${directorId}" [${family}]: ${chars} chars / ${bytes} bytes ` +
    `exceeds budget (${CHAR_BUDGET[directorId]} chars / ` +
    `${BYTE_BUDGET[directorId]} bytes). Trim the prompt (preferred) or ` +
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
      const overChars = row.chars > CHAR_BUDGET[row.directorId];
      const overBytes = row.bytes > BYTE_BUDGET[row.directorId];
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
