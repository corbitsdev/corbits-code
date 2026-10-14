import { describe, expect, test } from "bun:test";
import {
  MODEL_ROLE_DEFAULT_EFFORT,
  composeLeafRoleBody,
  defaultEffortForDirector,
  formatDirectorSystemPrompt,
  packageAllowedSkillNames,
} from "./identity.js";
import { DIRECTOR_REGISTRY } from "./registry.js";

describe("composeLeafRoleBody (single identity authority)", () => {
  test("keeps the formatted identity header over a family role body", () => {
    const formatted = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.coder);
    const composed = composeLeafRoleBody(formatted, "Role body text.");
    expect(composed.startsWith("Identity: agent id `coder`")).toBe(true);
    expect(composed).toContain("Model role: implement.");
    expect(composed.endsWith("\n\nRole body text.")).toBe(true);
    expect(composed).not.toContain("Identity: agent id `coder`.\n\nRole body");
    expect(composed.split("Identity: agent id").length - 1).toBe(1);
  });

  test("header boundary is the first blank line, never the card body", () => {
    const formatted = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.coder);
    const composed = composeLeafRoleBody(formatted, "X");
    expect(composed).not.toContain("CoderDirector (Coder)");
  });

  test("falls back to the raw body when no formatted prompt is available", () => {
    expect(composeLeafRoleBody(undefined, "X")).toBe("X");
  });
});

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
  test("returns undefined for universal skill access when unconfigured", () => {
    expect(packageAllowedSkillNames(DIRECTOR_REGISTRY.coder)).toBeUndefined();
    expect(
      packageAllowedSkillNames(DIRECTOR_REGISTRY.dispatch),
    ).toBeUndefined();
    expect(
      packageAllowedSkillNames(DIRECTOR_REGISTRY.explorer),
    ).toBeUndefined();
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
