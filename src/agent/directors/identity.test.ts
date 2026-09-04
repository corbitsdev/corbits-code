import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MODEL_ROLE_DEFAULT_EFFORT,
  defaultEffortForDirector,
  formatDirectorSystemPrompt,
} from "./identity.js";
import { DIRECTOR_REGISTRY } from "./registry.js";

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw.trim();
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw.trim();
  return raw.slice(end + 4).trim();
}

describe("formatDirectorSystemPrompt", () => {
  test("prefixes agent id, model role, and optional skills", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.builder);
    expect(text.startsWith("Identity: agent id `builder`")).toBe(true);
    expect(text).toContain('spawn_agent(agent="builder")');
    expect(text).toContain("Model role: implement.");
    expect(text).toContain("style, philosophy, native-integration, idiot-proof, typescript");
    expect(text).toContain(DIRECTOR_REGISTRY.builder.systemPrompt);
  });

  test("intern reports no optional skills by default", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.intern);
    expect(text).toContain("Optional skills: none by default");
  });

  test("bakes real style/philosophy/native-integration/idiot-proof/typescript bodies for builder workers (CL-6803)", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.builder);
    const style = stripFrontmatter(
      readFileSync(
        join(import.meta.dirname, "../../../plugins/corbits-skills/skills/style/SKILL.md"),
        "utf8",
      ),
    );
    const philosophy = stripFrontmatter(
      readFileSync(
        join(import.meta.dirname, "../../../plugins/corbits-skills/skills/philosophy/SKILL.md"),
        "utf8",
      ),
    );
    const nativeIntegration = stripFrontmatter(
      readFileSync(
        join(
          import.meta.dirname,
          "../../../plugins/corbits-skills/skills/native-integration/SKILL.md",
        ),
        "utf8",
      ),
    );
    const idiotProof = stripFrontmatter(
      readFileSync(
        join(import.meta.dirname, "../../../plugins/corbits-skills/skills/idiot-proof/SKILL.md"),
        "utf8",
      ),
    );
    const typescript = stripFrontmatter(
      readFileSync(
        join(import.meta.dirname, "../../../plugins/corbits-skills/skills/typescript/SKILL.md"),
        "utf8",
      ),
    );
    expect(text).toContain("# Baked skill guidance");
    expect(text).toContain(style);
    expect(text).toContain(philosophy);
    expect(text).toContain(nativeIntegration);
    expect(text).toContain(idiotProof);
    expect(text).toContain(typescript);
  });

  test("does not bake skill bodies when optionalSkills is empty", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.intern);
    expect(text).not.toContain("# Baked skill guidance");
  });

  test("does not advertise bake when no skill bodies resolve (total miss)", () => {
    const text = formatDirectorSystemPrompt({
      ...DIRECTOR_REGISTRY.builder,
      optionalSkills: ["does-not-exist-xyz"],
    });
    expect(text).not.toContain("# Baked skill guidance");
    expect(text).not.toMatch(/guidance is baked/i);
    expect(text).toContain(
      "Optional skills (names for awareness — use_skill is not mounted on workers)",
    );
    expect(text).toContain("does-not-exist-xyz");
  });

  test("skywalker does not bake skills or claim use_skill unmounted", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.skywalker);
    expect(text).not.toContain("# Baked skill guidance");
    expect(text).not.toContain("use_skill is not mounted on workers");
    expect(text).not.toMatch(/guidance is baked/i);
    expect(text).toContain("use_skill is primary-mounted");
    expect(text).toContain("style, philosophy, native-integration, interview");
  });

  test("counsel does not bake interview ask_operator guidance (CL-6803)", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.counsel);
    const interview = stripFrontmatter(
      readFileSync(
        join(import.meta.dirname, "../../../plugins/corbits-skills/skills/interview/SKILL.md"),
        "utf8",
      ),
    );
    expect(DIRECTOR_REGISTRY.counsel.optionalSkills).toEqual([
      "style",
      "philosophy",
      "native-integration",
    ]);
    expect(text).not.toContain(interview);
    expect(text).not.toContain("### interview");
    // interview recipe centers on ask_operator batches; counsel must not embed it
    expect(text).not.toMatch(/multiple-choice questions in batches via `ask_operator`/);
    expect(text).toContain("style, philosophy");
    expect(text).toContain("# Baked skill guidance");
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
