import { describe, expect, test } from "bun:test";
import {
  MODEL_ROLE_DEFAULT_EFFORT,
  defaultEffortForDirector,
  formatDirectorSystemPrompt,
  packageAllowedSkillNames,
} from "./identity.js";
import { DIRECTOR_REGISTRY } from "./registry.js";

const ATTACHED_STYLE_PHILOSOPHY = [
  "builder",
  "counsel",
  "critic",
  "greybeard",
  "neckbeard",
  "shakespeare",
  "gaasbot",
  "warden",
] as const;

describe("formatDirectorSystemPrompt", () => {
  test("prefixes agent id, model role, and lists skill names without bodies", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.builder);
    expect(text.startsWith("Identity: agent id `builder`")).toBe(true);
    expect(text).toContain('spawn_agent(agent="builder")');
    expect(text).toContain("Model role: implement.");
    for (const skill of ["style", "philosophy", "native-runtime"]) {
      expect(text).toContain(skill);
    }
    // Skill bodies are injected by attached-skills, never baked into the
    // director prompt itself.
    expect(text).not.toContain("# Baked skill guidance");
    expect(text).toContain(DIRECTOR_REGISTRY.builder.systemPrompt);
  });

  test("lists names even when no bodies would resolve", () => {
    const text = formatDirectorSystemPrompt({
      ...DIRECTOR_REGISTRY.builder,
      optionalSkills: ["does-not-exist-xyz"],
    });
    expect(text).toContain("does-not-exist-xyz");
  });
});

describe("packageAllowedSkillNames", () => {
  test("unions attached then optional without duplicating", () => {
    expect(packageAllowedSkillNames(DIRECTOR_REGISTRY.builder)).toEqual([
      "style",
      "philosophy",
      "native-runtime",
      "idiot-proof",
      "ponytail",
    ]);
    expect(packageAllowedSkillNames(DIRECTOR_REGISTRY.intern)).toEqual([]);
    expect(
      packageAllowedSkillNames(DIRECTOR_REGISTRY.explorer),
    ).toBeUndefined();
    expect(packageAllowedSkillNames(DIRECTOR_REGISTRY.skywalker)).toEqual([
      "style",
      "philosophy",
      "native-integration",
      "interview",
    ]);
  });

  test("attachedSkills is style+philosophy only on directors that listed both", () => {
    for (const pkg of Object.values(DIRECTOR_REGISTRY)) {
      if ((ATTACHED_STYLE_PHILOSOPHY as readonly string[]).includes(pkg.id)) {
        expect(pkg.attachedSkills).toEqual(["style", "philosophy"]);
        expect(pkg.optionalSkills ?? []).not.toContain("style");
        expect(pkg.optionalSkills ?? []).not.toContain("philosophy");
        continue;
      }
      expect(pkg.attachedSkills).toBeUndefined();
    }
  });
});

describe("defaultEffortForDirector", () => {
  test("intern is low; implement is medium; greybeard is high", () => {
    expect(defaultEffortForDirector(DIRECTOR_REGISTRY.intern)).toBe("low");
    expect(defaultEffortForDirector(DIRECTOR_REGISTRY.builder)).toBe(
      MODEL_ROLE_DEFAULT_EFFORT.implement,
    );
    expect(defaultEffortForDirector(DIRECTOR_REGISTRY.greybeard)).toBe("high");
    expect(defaultEffortForDirector(DIRECTOR_REGISTRY.skywalker)).toBe("high");
  });
});
