import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

/**
 * Composed-output pin (CL-10674). The fragment package is the only copy of
 * the card prose; these hashes fail when a fragment edit changes bytes.
 * Director modules must keep calling the composed card, not restating it.
 */
const CARD_SHA256: Record<(typeof DIRECTOR_IDS)[number], string> = {
  dispatch: "0ce0493f3119a02b999b87b5e5c51d61df01ae8042923710404cae6ee9758328",
  explorer: "d4cac32fe0703953bf4d68c68b02aa67e3e50d2172b8137c5692ccdb1afc76eb",
  planner: "6ce04bb2349e9a67cfab538c1cbcb08c4eaa7dfe2eb40dca94bd022e4608bc23",
  coder: "6e872830d642935e98407b1e45a23740e73c731abfb3e6297a242201abd09092",
  reviewer: "9de0237970a17a030db9bc4c387d46d5d25788e91a806a7e9713b93778d75d5b",
  designer: "d021f346f451eda0770d6580b7647441311c89faef919e670ac6ab4ae9aa297f",
  artist: "8ba1a961af72fabbaa6310b322e931872aa759e6572dda327f48d9deefe12ecb",
  warden: "585add005436fea88c84b66d2f0aaa0bc4454c8165b6951989678226ebd0e27c",
  shakespeare:
    "e993db0e6bee1090aa64c1a7f8501e6c87c15e6eed26ce686b7efba7fcfd9541",
  prober: "a34f956da1245a4f370eeedeb71e09f4dfe3d6df009b0083fc5220a30790ac59",
  "qa-lead": "5beb75426761fdf952fdd889fb06c3152d90e2ead9358071d747169b10518c0e",
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("director cards compose from prompt-fragments", () => {
  test("registry system prompts are the composed cards", () => {
    for (const id of DIRECTOR_IDS) {
      expect(DIRECTOR_REGISTRY[id].systemPrompt).toBe(DIRECTOR_CARDS[id]);
    }
  });

  test("composed output hash pin", () => {
    for (const id of DIRECTOR_IDS) {
      expect(sha256(DIRECTOR_CARDS[id])).toBe(CARD_SHA256[id]);
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

  test("director modules do not embed a second copy of the card", () => {
    for (const id of DIRECTOR_IDS) {
      const path =
        id === "qa-lead"
          ? new URL("./qa-lead/package.ts", import.meta.url)
          : new URL(`../../../agents/${id}/src/prompt.ts`, import.meta.url);
      const text = readFileSync(path, "utf8");
      expect(text).not.toContain("PRIMARY INTENT");
      expect(text).not.toContain("OUT OF LANE:");
      expect(text).not.toContain("# Route");
    }
  });
});
