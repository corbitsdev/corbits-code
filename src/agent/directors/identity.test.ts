import { describe, expect, test } from "bun:test";
import {
  MODEL_ROLE_DEFAULT_EFFORT,
  defaultEffortForDirector,
  formatDirectorSystemPrompt,
} from "./identity.js";
import { DIRECTOR_REGISTRY } from "./registry.js";
import { DIRECTOR_IDS } from "./types.js";

describe("formatDirectorSystemPrompt", () => {
  test("leads with identity, then required skills, then the package body", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.implement);
    expect(text.startsWith("You are Implement.")).toBe(true);
    expect(text).toContain('task(agent="implement")');
    expect(text).not.toContain("Model role:");
    expect(text).not.toContain("Identity: agent id");
    expect(text).toContain("Required skills — load with use_skill BEFORE other work: style, philosophy.");
    expect(text).toContain("Optional skills — load with use_skill when they apply: typescript.");
    expect(text).toContain(DIRECTOR_REGISTRY.implement.systemPrompt);
    expect(text).not.toContain("use_skill is not mounted");
  });

  test("intern lists no default skills but still has use_skill", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.intern);
    expect(text.startsWith("You are Intern.")).toBe(true);
    expect(text).toContain("Skills: none listed");
    expect(text).not.toContain("Model role:");
  });

  test("greybeard requires style and philosophy with no optional list", () => {
    const text = formatDirectorSystemPrompt(DIRECTOR_REGISTRY.greybeard);
    expect(text.startsWith("You are Greybeard.")).toBe(true);
    expect(text).toContain("Required skills — load with use_skill BEFORE other work: style, philosophy.");
    expect(text).not.toContain("Optional skills");
  });

  test("Skywalker is not double-greeted", () => {
    const pkg = DIRECTOR_REGISTRY.skywalker;
    const text = formatDirectorSystemPrompt(pkg);
    expect(pkg.systemPrompt.startsWith(`You are ${pkg.name}`)).toBe(true);
    expect(text.startsWith("Spawn as task")).toBe(true);
    expect(text).toContain('task(agent="skywalker")');
    expect((text.match(/You are Skywalker/g) ?? []).length).toBe(1);
    expect(text).toContain(pkg.systemPrompt);
  });

  test("every DIRECTOR_IDS package has a non-empty name and identity-first greeting", () => {
    for (const id of DIRECTOR_IDS) {
      const pkg = DIRECTOR_REGISTRY[id];
      expect(pkg.name.length).toBeGreaterThan(0);
      const text = formatDirectorSystemPrompt(pkg);
      expect(text).toContain(`task(agent="${pkg.id}")`);
      expect(text).not.toContain("Model role:");
      if (pkg.systemPrompt.startsWith(`You are ${pkg.name}`)) {
        expect(text.startsWith(`You are ${pkg.name}.`)).toBe(false);
        expect(text).toContain(`You are ${pkg.name}`);
      } else {
        expect(text.startsWith(`You are ${pkg.name}.`)).toBe(true);
      }
    }
  });
});

describe("defaultEffortForDirector", () => {
  test("intern is low; implement is medium; greybeard is high", () => {
    expect(defaultEffortForDirector(DIRECTOR_REGISTRY.intern)).toBe("low");
    expect(defaultEffortForDirector(DIRECTOR_REGISTRY.implement)).toBe(
      MODEL_ROLE_DEFAULT_EFFORT.implement,
    );
    expect(defaultEffortForDirector(DIRECTOR_REGISTRY.greybeard)).toBe("high");
    expect(defaultEffortForDirector(DIRECTOR_REGISTRY.skywalker)).toBe("high");
  });
});
