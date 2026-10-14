import { describe, expect, test } from "bun:test";

import {
  GOLDEN_CARDS,
  GOLDEN_DSV4,
} from "../../../packages/prompt-fragments/src/index.js";
import {
  dsv4CoderBodyRow,
  dsv4LeafRow,
  dsv4PrimaryRow,
  dsv4ReviewerBodyRow,
} from "../../../packages/prompt-variance/src/index.js";
import {
  composeLeafRoleBody,
  formatDirectorIdentityHeader,
  formatDirectorSystemPrompt,
} from "./identity.js";
import { DIRECTOR_REGISTRY } from "./registry.js";
import { DIRECTOR_IDS } from "./types.js";
import { resolveModelFamilyPolicy } from "../model-family-policy.js";
/**
 * Golden byte pin (CL-10674). Every composed card and every rehomed DSV4 row
 * must equal its recorded golden — the blessed, verbatim production bytes
 * (each card proven byte-equal to the pre-composition source card; DSV4
 * residuals proven byte-identical to the pre-rehoming inline text). A
 * fragment or composer change fails here until the goldens are regenerated
 * deliberately (tmp/fragments-verify/gen-goldens.ts) together with the
 * prompt-size baselines.
 */
describe("golden byte pin — composed cards", () => {
  test("goldens cover exactly the closed director set", () => {
    expect(Object.keys(GOLDEN_CARDS).sort()).toEqual([...DIRECTOR_IDS].sort());
  });

  for (const id of DIRECTOR_IDS) {
    test(`[${id}] composed card === golden bytes (${Object.entries(GOLDEN_CARDS).find(([k]) => k === id)?.[1].length ?? "?"} chars)`, () => {
      expect(DIRECTOR_REGISTRY[id].systemPrompt.length).toBe(
        GOLDEN_CARDS[id].length,
      );
      expect(DIRECTOR_REGISTRY[id].systemPrompt).toBe(GOLDEN_CARDS[id]);
    });
  }
});

describe("golden byte pin — DSV4 rows and composed wires", () => {
  test("d1 orchestrator residual is the blessed verbatim text", () => {
    expect(dsv4PrimaryRow.residual).toBe(GOLDEN_DSV4.primary);
    expect(dsv4PrimaryRow.residual.length).toBe(1860);
  });

  test("g2 leaf residual is the blessed verbatim text", () => {
    expect(dsv4LeafRow.residual).toBe(GOLDEN_DSV4.leaf);
    expect(dsv4LeafRow.residual.length).toBe(1348);
  });

  test("slim role bodies match the goldens the wires compose", () => {
    expect(dsv4CoderBodyRow.residual).not.toContain("Identity: agent id");
    expect(dsv4ReviewerBodyRow.residual).not.toContain("Identity: agent id");
  });

  test("DSV4 coder leaf wire = identity header + body, once (golden)", () => {
    const wire = composeLeafRoleBody(
      formatDirectorSystemPrompt(DIRECTOR_REGISTRY.coder),
      dsv4CoderBodyRow.residual,
    );
    expect(wire).toBe(GOLDEN_DSV4.coderComposed);
    expect(wire.length).toBe(1649);
    expect(wire.split("Identity: agent id").length - 1).toBe(1);
  });

  test("DSV4 reviewer leaf wire = identity header + body, once (golden)", () => {
    const wire = composeLeafRoleBody(
      formatDirectorSystemPrompt(DIRECTOR_REGISTRY.reviewer),
      dsv4ReviewerBodyRow.residual,
    );
    expect(wire).toBe(GOLDEN_DSV4.reviewerComposed);
    expect(wire.length).toBe(1169);
    expect(wire.split("Identity: agent id").length - 1).toBe(1);
  });

  test("d1 orchestrator path routes the golden primary residual", () => {
    const policy = resolveModelFamilyPolicy({
      providerName: "deepseek",
      model: "DeepSeek-V4",
      orchestrator: true,
    });
    expect(policy.family).toBe("deepseek");
    expect(policy.promptResidual).toBe(GOLDEN_DSV4.primary);
    // The composed wire path (header + body) is what run.ts puts on the wire
    // for deepseek leaves; the header formatter is the single authority.
    expect(formatDirectorIdentityHeader(DIRECTOR_REGISTRY.coder)).toContain(
      'spawn_agent(agent="coder")',
    );
    expect(formatDirectorSystemPrompt(DIRECTOR_REGISTRY.coder)).toContain(
      DIRECTOR_REGISTRY.coder.systemPrompt,
    );
  });
});
