import { describe, expect, test } from "bun:test";
import {
  MODEL_ROLE_DEFAULT_EFFORT,
  defaultEffortForDirector,
  formatDirectorSystemPrompt,
} from "./identity.js";
import { buildWorkerContract } from "../worker-contract.js";
import { DIRECTOR_REGISTRY } from "./registry.js";

const SKILL_LIST_BY_DIRECTOR = {
  builder: "style, philosophy, native-runtime, idiot-proof, ponytail",
  counsel: "style, philosophy, native-integration",
  skywalker: "style, philosophy, native-integration, interview",
} as const;

describe("formatDirectorSystemPrompt", () => {
  test("prefixes agent id, model role, and optional skills", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.builder);
    expect(text.startsWith("Identity: agent id `builder`")).toBe(true);
    expect(text).toContain('spawn_agent(agent="builder")');
    expect(text).toContain("Model role: implement.");
    expect(text).toContain(SKILL_LIST_BY_DIRECTOR.builder);
    expect(text).toContain(DIRECTOR_REGISTRY.builder.systemPrompt);
  });

  test("intern reports no optional skills by default", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.intern);
    expect(text).toContain("Optional skills: none by default");
  });

  test("worker lists skill names with no bodies and no scoping rule (contract owns it)", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.builder);
    expect(text).not.toContain("# Baked skill guidance");
    expect(text).toContain(
      `Optional skills (names for awareness; load brief-named skills straight through use_skill, skill_search for discovery when mounted): ${SKILL_LIST_BY_DIRECTOR.builder}.`,
    );
    // The skill-escalation rule lives in the worker contract (CL-8212), not
    // in every director body.
    expect(text).not.toContain("search only when the brief names a skill");
    expect(text).not.toContain("load only the skills the task needs");
    expect(buildWorkerContract({ askDirector: true })).toContain(
      "Skills are available; search only when the brief names a skill or the task is outside your lane. For a small, bounded edit, do not search skills.",
    );
  });

  test("worker guidance never mandates skill_search (deny-safe for grok/kimi leaves)", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.builder);
    expect(text).not.toContain("Call skill_search for descriptions");
    // The deny-safe discovery clause lives in the worker contract.
    expect(buildWorkerContract({ askDirector: true })).toContain(
      "only when choosing among skills and it is mounted",
    );
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

  test("lists names with no scoping rule even when no bodies would resolve", () => {
    const text = formatDirectorSystemPrompt({
      ...DIRECTOR_REGISTRY.builder,
      optionalSkills: ["does-not-exist-xyz"],
    });
    expect(text).not.toContain("# Baked skill guidance");
    expect(text).toContain(
      "Optional skills (names for awareness; load brief-named skills straight through use_skill, skill_search for discovery when mounted): does-not-exist-xyz.",
    );
    // The scoping rule lives in the worker contract (CL-8212).
    expect(text).not.toContain("search only when the brief names a skill");
  });

  test("skywalker does not bake skills or claim use_skill unmounted", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.skywalker);
    expect(text).not.toContain("# Baked skill guidance");
    expect(text).not.toContain("use_skill is not mounted on workers");
    expect(text).not.toMatch(/guidance is baked/i);
    expect(text).toContain("use_skill is primary-mounted");
    expect(text).toContain(SKILL_LIST_BY_DIRECTOR.skywalker);
  });

  test("counsel lists skill names with no scoping rule and no bodies (CL-6803)", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.counsel);
    expect(text).not.toContain("# Baked skill guidance");
    expect(text).not.toContain("### interview");
    // interview recipe centers on ask_operator batches; counsel must not embed it
    expect(text).not.toMatch(
      /multiple-choice questions in batches via `ask_operator`/,
    );
    expect(text).toContain(SKILL_LIST_BY_DIRECTOR.counsel);
    // The scoping rule lives in the worker contract (CL-8212).
    expect(text).not.toContain("search only when the brief names a skill");
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
