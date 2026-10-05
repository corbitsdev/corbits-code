import { describe, expect, test } from "bun:test";
import {
  MODEL_ROLE_DEFAULT_EFFORT,
  defaultEffortForDirector,
  formatDirectorSystemPrompt,
  packageAllowedSkillNames,
} from "./identity.js";
import { DIRECTOR_REGISTRY } from "./registry.js";

describe("formatDirectorSystemPrompt", () => {
  test("prefixes agent id, model role, and formats system prompt", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.coder);
    expect(text.startsWith("Identity: agent id `coder`")).toBe(true);
    expect(text).toContain('spawn_agent(agent="coder")');
    expect(text).toContain("Model role: implement.");
    expect(text).toContain(DIRECTOR_REGISTRY.coder.systemPrompt);
  });

  test("lists skills when configured", () => {
    const text = formatDirectorSystemPrompt({
      ...DIRECTOR_REGISTRY.coder,
      optionalSkills: ["does-not-exist-xyz"],
    });
    expect(text).toContain("does-not-exist-xyz");
  });
});

describe("packageAllowedSkillNames", () => {
  test("returns empty allowlist when neither field is declared", () => {
    expect(packageAllowedSkillNames(undefined)).toBeUndefined();
    expect(packageAllowedSkillNames(DIRECTOR_REGISTRY.dispatch)).toEqual([]);
    expect(packageAllowedSkillNames(DIRECTOR_REGISTRY.explorer)).toEqual([]);
  });

  test("coder optionalSkills is typescript", () => {
    expect(packageAllowedSkillNames(DIRECTOR_REGISTRY.coder)).toEqual([
      "typescript",
    ]);
  });

  test("designer optionalSkills include better-ui and emil-design-eng", () => {
    expect(packageAllowedSkillNames(DIRECTOR_REGISTRY.designer)).toEqual([
      "emil-design-eng",
      "better-ui",
    ]);
  });

  test("unions attached then optional without duplicating when configured", () => {
    expect(
      packageAllowedSkillNames({
        ...DIRECTOR_REGISTRY.coder,
        attachedSkills: ["style"],
        optionalSkills: ["style", "philosophy"],
      }),
    ).toEqual(["style", "philosophy"]);
  });
});

describe("defaultEffortForDirector", () => {
  test("resolves correct effort levels for directors", () => {
    expect(defaultEffortForDirector(DIRECTOR_REGISTRY.coder)).toBe(
      MODEL_ROLE_DEFAULT_EFFORT.implement,
    );
    expect(defaultEffortForDirector(DIRECTOR_REGISTRY.planner)).toBe(
      MODEL_ROLE_DEFAULT_EFFORT.plan,
    );
    expect(defaultEffortForDirector(DIRECTOR_REGISTRY.dispatch)).toBe("high");
  });
});
