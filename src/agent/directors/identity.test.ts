import { describe, expect, test } from "bun:test";
import {
  MODEL_ROLE_DEFAULT_EFFORT,
  WORKER_SKILL_SCOPING,
  defaultEffortForDirector,
  formatDirectorSystemPrompt,
} from "./identity.js";
import { DIRECTOR_REGISTRY } from "./registry.js";

describe("formatDirectorSystemPrompt", () => {
  test("prefixes agent id, model role, and optional skills", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.builder);
    expect(text.startsWith("Identity: agent id `builder`")).toBe(true);
    expect(text).toContain('spawn_agent(agent="builder")');
    expect(text).toContain("Model role: implement.");
    expect(text).toContain(
      "style, philosophy, native-runtime, idiot-proof, ponytail",
    );
    expect(text).toContain(DIRECTOR_REGISTRY.builder.systemPrompt);
  });

  test("intern reports no optional skills by default", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.intern);
    expect(text).toContain("Optional skills: none by default");
  });

  test("worker lists skill names with the scoping rule and no bodies", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.builder);
    expect(text).not.toContain("# Baked skill guidance");
    expect(text).toContain(
      "Optional skills (names for awareness; load brief-named skills straight through use_skill, skill_search for discovery when mounted): style, philosophy, native-runtime, idiot-proof, ponytail.",
    );
    expect(text).toContain(WORKER_SKILL_SCOPING);
    expect(text).toContain(
      "Skills are available; search only when the brief names a skill or the task is outside your lane. For a small, bounded edit, do not search skills.",
    );
    expect(text).toContain(
      "Load a brief-named skill straight through use_skill",
    );
    expect(text).toContain("load only the skills the task needs");
  });

  test("worker guidance never mandates skill_search (deny-safe for grok/kimi leaves)", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.builder);
    expect(text).not.toContain("Call skill_search for descriptions");
    expect(text).toContain("only when choosing among skills and it is mounted");
  });

  test("skywalker does not bake Ponytail", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.skywalker);
    expect(text).not.toContain("### ponytail");
    expect(text).not.toMatch(/ponytail/i);
    expect(text).not.toContain("Default to `lite`");
    expect(text).not.toContain("Escalation ladder");
  });

  test("does not bake skill bodies when optionalSkills is empty", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.intern);
    expect(text).not.toContain("# Baked skill guidance");
  });

  test("lists names with the scoping rule even when no bodies would resolve", () => {
    const text = formatDirectorSystemPrompt({
      ...DIRECTOR_REGISTRY.builder,
      optionalSkills: ["does-not-exist-xyz"],
    });
    expect(text).not.toContain("# Baked skill guidance");
    expect(text).toContain(
      "Optional skills (names for awareness; load brief-named skills straight through use_skill, skill_search for discovery when mounted): does-not-exist-xyz.",
    );
    expect(text).toContain(WORKER_SKILL_SCOPING);
  });

  test("skywalker does not bake skills or claim use_skill unmounted", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.skywalker);
    expect(text).not.toContain("# Baked skill guidance");
    expect(text).not.toContain("use_skill is not mounted on workers");
    expect(text).not.toMatch(/guidance is baked/i);
    expect(text).toContain("use_skill is primary-mounted");
    expect(text).toContain("style, philosophy, native-integration, interview");
  });

  test("counsel lists skill names with the scoping rule and no bodies (CL-6803)", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.counsel);
    expect(DIRECTOR_REGISTRY.counsel.optionalSkills).toEqual([
      "style",
      "philosophy",
      "native-integration",
    ]);
    expect(text).not.toContain("# Baked skill guidance");
    expect(text).not.toContain("### interview");
    // interview recipe centers on ask_operator batches; counsel must not embed it
    expect(text).not.toMatch(
      /multiple-choice questions in batches via `ask_operator`/,
    );
    expect(text).toContain("style, philosophy");
    expect(text).toContain(WORKER_SKILL_SCOPING);
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
