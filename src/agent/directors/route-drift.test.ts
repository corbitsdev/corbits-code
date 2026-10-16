import { describe, expect, test } from "bun:test";

import { DISPATCH_ROUTE_ROWS } from "../../../packages/prompt-fragments/src/index.js";
import { DIRECTOR_REGISTRY } from "./registry.js";
import { DIRECTOR_IDS } from "./types.js";

/**
 * Dispatch route drift pin (CL-10674 P3): the dispatch card composes its
 * `# Route` section from DISPATCH_ROUTE_ROWS, not from hand-held duplicates.
 * Adding a director fails here until a matching route row lands in the
 * fragments package; removing one fails until the row is retired.
 */
describe("dispatch route table drift", () => {
  test("route rows cover exactly the registry lanes dispatch can spawn", () => {
    const spawnableLanes = DIRECTOR_IDS.filter((id) => id !== "dispatch");
    const rowLanes = DISPATCH_ROUTE_ROWS.map((row) => row.lane);
    expect([...rowLanes].sort()).toEqual([...spawnableLanes].sort());
  });

  test("route rows carry no duplicate lane and no unknown lane", () => {
    expect(new Set(DISPATCH_ROUTE_ROWS.map((r) => r.lane)).size).toBe(
      DISPATCH_ROUTE_ROWS.length,
    );
    for (const row of DISPATCH_ROUTE_ROWS) {
      expect(
        (DIRECTOR_IDS as readonly string[]).includes(row.lane),
        `route row lane "${row.lane}" is not a director id`,
      ).toBe(true);
    }
  });

  test("the composed route section carries every registry card body hint", () => {
    // The dispatch card body embeds the generated section; make sure the
    // generated rows are byte-faithful to the composed card (P3 pin).
    const card = DIRECTOR_REGISTRY.dispatch.systemPrompt;
    for (const row of DISPATCH_ROUTE_ROWS) {
      expect(card).toContain(`spawn ${row.lane} (`);
    }
    const sectionStart = card.indexOf("# Route\n");
    expect(sectionStart).toBeGreaterThanOrEqual(0);
    const sectionEnd = card.indexOf("\n\n# Delegation boundary");
    const section = card
      .slice(sectionStart + "# Route\n".length, sectionEnd)
      .split("\n");

    // Regenerate the rows exactly as the fragment builder does and pin bytes.
    const generated = DISPATCH_ROUTE_ROWS.map((row) =>
      row.footer === undefined
        ? `- ${row.task}: spawn ${row.lane} (${row.hint}).`
        : `- ${row.task}: spawn ${row.lane} (${row.hint}). ${row.footer}`,
    );
    expect(section).toEqual(generated);
  });
});
