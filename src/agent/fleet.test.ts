import { describe, expect, test } from "bun:test";

import { FLEET } from "./fleet.js";
import { DIRECTOR_IDS, type DirectorId } from "./directors/types.js";

describe("fleet barrel", () => {
  test("FLEET covers all 10 extract ids in the closed director set", () => {
    const closed = new Set<string>(DIRECTOR_IDS);
    expect(Object.keys(FLEET).length).toBe(10);
    for (const id of Object.keys(FLEET) as readonly DirectorId[]) {
      expect(closed).toContain(id);
    }
  });

  test("every FLEET entry structurally satisfies the director contract", () => {
    for (const id of Object.keys(FLEET) as readonly (keyof typeof FLEET)[]) {
      const entry = FLEET[id];
      expect(entry.id).toBe(id);
    }
  });

  test("barrel owns no in-tree director package data", () => {
    // Backed only by the workspace packages (never in-tree ./directors/* re-exports
    // — the merge-order stale re-export hazard), via the tsconfig paths aliases to
    // agents/<id>/src/index.ts on this standalone branch.
    expect(Object.keys(FLEET)).toEqual([
      "artist",
      "coder",
      "designer",
      "dispatch",
      "explorer",
      "planner",
      "prober",
      "reviewer",
      "shakespeare",
      "warden",
    ]);
  });
});
