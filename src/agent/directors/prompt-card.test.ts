import { describe, expect, test } from "bun:test";

import {
  DIRECTOR_CARDS,
  DISPATCH_ROUTE_ROWS,
  REPORT_ENVELOPE_SHAPE,
  dispatchRouteSection,
  doneGate,
  identityLine,
  outOfLane,
} from "../../../packages/prompt-fragments/src/index.js";
import { DIRECTOR_REGISTRY } from "./registry.js";
import { DIRECTOR_IDS } from "./types.js";

describe("director cards compose from prompt-fragments", () => {
  test("registry system prompts are the composed cards", () => {
    for (const id of DIRECTOR_IDS) {
      expect(DIRECTOR_REGISTRY[id].systemPrompt).toBe(DIRECTOR_CARDS[id]);
    }
  });

  test("shared frames are the fragment helpers, not a second wording", () => {
    expect(DIRECTOR_CARDS.explorer.startsWith(identityLine("Explorer"))).toBe(
      true,
    );
    expect(DIRECTOR_CARDS.coder).toContain(REPORT_ENVELOPE_SHAPE);
    expect(DIRECTOR_CARDS.coder).toContain(
      outOfLane(
        "pure exploration maps, speculative abstractions, review-only verdicts, mechanical command lists without implementing, fleet orchestration or spawning",
      ),
    );
    expect(DIRECTOR_CARDS.explorer).toContain(
      doneGate(
        "every success_criteria item from the brief is answered",
        "Do not invent architecture, ship code, or expand the brief after criteria are satisfied. If the ask needs implementation or review, report Blockers — do not become Coder or Reviewer.",
      ),
    );
    expect(DIRECTOR_CARDS.dispatch).toContain(dispatchRouteSection());
    expect(DISPATCH_ROUTE_ROWS.map((row) => row.lane).sort()).toEqual(
      DIRECTOR_IDS.filter((id) => id !== "dispatch").sort(),
    );
  });
});
