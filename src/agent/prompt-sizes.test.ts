import { describe, expect, test } from "bun:test";
import { DIRECTOR_REGISTRY } from "./directors/registry.js";
import { DIRECTOR_IDS, type DirectorId } from "./directors/types.js";
import {
  directorPromptSizeTable,
  type PromptSizeFamily,
} from "./prompt-sizes.js";

/**
 * Prompt size budget (CL-7664). Numeric asserts only — copy edits must not
 * fail this test. Baselines were captured from the canonical fixture in
 * src/agent/prompt-sizes.ts with a +2000 char / +3000 byte allowance; bytes
 * get the larger headroom because multibyte copy can shift them faster.
 */
const CHAR_BUDGET: Record<DirectorId, number> = {
  skywalker: 28000,
  builder: 49000,
  explorer: 14200,
  counsel: 52800,
  intern: 16800,
  critic: 54400,
  greybeard: 54300,
  neckbeard: 72300,
  bruckheimer: 23400,
  gaasbot: 31800,
  draper: 15200,
  emil: 16700,
  rand: 15100,
  shakespeare: 54900,
  testsmith: 16200,
  tester: 14000,
};

const BYTE_BUDGET: Record<DirectorId, number> = {
  skywalker: 29100,
  builder: 50100,
  explorer: 15300,
  counsel: 53900,
  intern: 17900,
  critic: 55600,
  greybeard: 55500,
  neckbeard: 73500,
  bruckheimer: 24400,
  gaasbot: 32900,
  draper: 16300,
  emil: 17800,
  rand: 16200,
  shakespeare: 56000,
  testsmith: 17300,
  tester: 15100,
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
});
