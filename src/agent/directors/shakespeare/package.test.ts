import { describe, expect, test } from "bun:test";
import { shakespearePackage } from "./package.js";

describe("shakespearePackage", () => {
  test("id matches directory / registry id", () => {
    expect(shakespearePackage.id).toBe("shakespeare");
  });

  test("systemPrompt is non-empty and not a Placeholder", () => {
    expect(shakespearePackage.systemPrompt.length).toBeGreaterThan(0);
    expect(shakespearePackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt identity is Shakespeare / ShakespeareDirector", () => {
    const p = shakespearePackage.systemPrompt;
    expect(p).toMatch(/ShakespeareDirector \(Shakespeare\)/);
    expect(p).toContain("PRIMARY INTENT");
    expect(p).toMatch(/docs lane only/i);
    expect(p).toMatch(/PRODUCT\.md/);
    expect(p).toMatch(/ARCHITECTURE\.md/);
    expect(p).toMatch(/IMPLEMENTATION\.md/);
  });

  test("systemPrompt bakes scribe workflow without requiring use_skill scribe", () => {
    const prompt = shakespearePackage.systemPrompt;
    expect(prompt).toMatch(/Document discovery|document discovery/i);
    expect(prompt).toMatch(/gap/i);
    expect(prompt).toMatch(/cross-document|cross-doc|consistency/i);
    expect(prompt).toMatch(/Blockers|question/i);
    expect(prompt).not.toMatch(/use_skill\s*\(\s*["']scribe["']\s*\)/);
  });

  test("systemPrompt has blinders-on / brief-scoped docs work", () => {
    const p = shakespearePackage.systemPrompt;
    expect(p).toMatch(/BLINDERS ON/i);
    expect(p).toMatch(/success_criteria/i);
    expect(p).toMatch(/Do not wander/i);
    expect(p).toMatch(/P\/A\/I|PRODUCT|ARCHITECTURE|IMPLEMENTATION/);
  });

  test("systemPrompt has DONE GATE for success_criteria", () => {
    const prompt = shakespearePackage.systemPrompt;
    expect(prompt).toContain("DONE GATE");
    expect(prompt).toContain("success_criteria");
    expect(prompt).toMatch(/[Ss]top when/);
  });

  test("systemPrompt has no tool-schema restatement or fake caps", () => {
    const p = shakespearePackage.systemPrompt;
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/fan-out/i);
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/2–4/);
    expect(p).not.toMatch(/3\+/);
    expect(p).not.toMatch(/turn budget/i);
    expect(p).not.toMatch(/scheduler/i);
    expect(p).not.toMatch(/Prefer grep\/search_files/i);
    expect(p).not.toMatch(/Shell find\/rg/i);
    expect(p).not.toMatch(/Write tools are mounted with no path lock/i);
  });

  test("systemPrompt stays on docs lane (not Builder / Critic / fleet)", () => {
    const p = shakespearePackage.systemPrompt;
    expect(p).toMatch(/not Builder/i);
    expect(p).toMatch(/not Critic/i);
    expect(p).toMatch(/not an orchestrator/i);
    expect(p).toMatch(/PRODUCT \/ ARCHITECTURE \/ IMPLEMENTATION|PRODUCT\.md/);
    expect(p).toMatch(/do not become Builder, Critic, or Rand/i);
  });

  test("spawn.maySpawn is false (leaf)", () => {
    expect(shakespearePackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow includes write tools", () => {
    const allow = shakespearePackage.tools?.allow ?? [];
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("modelRole is docs", () => {
    expect(shakespearePackage.modelRole).toBe("docs");
  });

  test("optionalSkills are style and philosophy", () => {
    expect(shakespearePackage.optionalSkills).toEqual([
      "style",
      "philosophy",
      "native-integration",
    ]);
  });

  test("primaryIntent is docs maintain", () => {
    expect(shakespearePackage.primaryIntent).toMatch(/docs|documentation|PRODUCT|product/i);
  });
});
