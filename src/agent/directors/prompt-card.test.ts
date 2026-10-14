import { describe, expect, test } from "bun:test";

import {
  DISPATCH_ROUTE_ROWS,
  REPORT_ENVELOPE_SHAPE,
} from "../../../packages/prompt-fragments/src/index.js";
import { DIRECTOR_REGISTRY } from "./registry.js";
import { DIRECTOR_IDS } from "./types.js";

/**
 * Fragment composition byte-stability (CL-10674 P1): cards compose the shared
 * prompt fragments and keep only lane-specific shape. These are the structural
 * frame asserts (frames appear exactly once, per adopted lane); the exact byte
 * pin is src/agent/directors/prompt-golden.test.ts, which compares every
 * registry card against the blessed, HEAD~1-equal golden bytes in
 * packages/prompt-fragments/src/goldens.ts. That guarded pin makes "a
 * fragment change is a fleet-wide prompt change" a contract, not a hope: a
 * fragment edit fails the golden pin until the goldens are regenerated
 * deliberately alongside the size baselines (src/agent/prompt-sizes.test.ts).
 */
describe("prompt fragment composition byte-stability", () => {
  // Cards that adopt the DONE GATE / OUT OF LANE / identity fragments.
  const OBSERVATIONS = {
    identityBanner: [
      "artist",
      "coder",
      "designer",
      "explorer",
      "planner",
      "prober",
      "reviewer",
      "shakespeare",
      "warden",
    ],
    envelopeShape: [
      "artist",
      "coder",
      "designer",
      "planner",
      "prober",
      "qa-lead",
      "reviewer",
    ],
    doneGate: ["explorer", "shakespeare"],
    outOfLaneLine: [
      "artist",
      "coder",
      "designer",
      "explorer",
      "planner",
      "qa-lead",
      "reviewer",
      "shakespeare",
    ],
  } as const;

  const card = (id: (typeof DIRECTOR_IDS)[number]): string =>
    DIRECTOR_REGISTRY[id].systemPrompt;

  for (const id of OBSERVATIONS.identityBanner) {
    test(`[${id}] identity banner composes once`, () => {
      const banner = card(id).split("\n")[0];
      expect(banner).toMatch(
        /^You are \w+Director \(\w+\), a specialist in Corbits Code\.$/,
      );
    });
  }

  for (const id of OBSERVATIONS.envelopeShape) {
    test(`[${id}] report envelope shape is the single fragment string`, () => {
      expect(card(id)).toContain(REPORT_ENVELOPE_SHAPE);
      expect(
        card(id).split(REPORT_ENVELOPE_SHAPE).length - 1,
      ).toBeGreaterThanOrEqual(1);
    });
  }

  for (const id of OBSERVATIONS.doneGate) {
    test(`[${id}] done gate frame composes once`, () => {
      expect(card(id).split("DONE GATE: Stop when ").length - 1).toBe(1);
      expect(card(id)).toContain(
        "OR explicitly blocked under Blockers. Do not ",
      );
    });
  }

  for (const id of OBSERVATIONS.outOfLaneLine) {
    test(`[${id}] out-of-lane line frame composes once`, () => {
      expect(card(id).split("\nOUT OF LANE: ").length - 1).toBe(1);
    });
  }

  test("prober keeps its lane-wrapped literal until a measured unwrap", () => {
    // Prober's DONE GATE / OUT OF LANE blocks are hand-wrapped 80-col text;
    // adopting the single-line fragments would change bytes, so they stay
    // literal until blessed as a deliberate baseline move.
    expect(card("prober")).toContain(
      "DONE GATE: stop when the brief's measure ask is answered with evidence\nOR explicitly blocked under Blockers.",
    );
    expect(card("prober")).toContain(
      "OUT OF LANE: shipping product code, tuning prompts or model-family\npolicy",
    );
  });

  test("dispatch composes its route section from the shared table", () => {
    for (const row of DISPATCH_ROUTE_ROWS) {
      expect(card("dispatch")).toContain(`spawn ${row.lane} (${row.hint}`);
    }
  });

  test("no card duplicates the done-gate or out-of-lane frame", () => {
    for (const id of DIRECTOR_IDS) {
      expect(card(id).split("DONE GATE:").length - 1).toBeLessThanOrEqual(1);
      expect(
        card(id).split(/\bOUT OF LANE[:\u2192]/).length - 1,
      ).toBeLessThanOrEqual(1);
    }
  });
});
