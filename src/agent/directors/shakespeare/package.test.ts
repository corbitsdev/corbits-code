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

  test("systemPrompt names Shakespeare and states PRIMARY INTENT", () => {
    expect(shakespearePackage.systemPrompt).toMatch(/Shakespeare/i);
    expect(shakespearePackage.systemPrompt).toContain("PRIMARY INTENT");
    expect(shakespearePackage.systemPrompt).toMatch(/product/i);
    expect(shakespearePackage.systemPrompt).toMatch(/architecture/i);
    expect(shakespearePackage.systemPrompt).toMatch(/implementation/i);
  });

  test("systemPrompt bakes scribe workflow without requiring use_skill scribe", () => {
    const prompt = shakespearePackage.systemPrompt;
    expect(prompt).toMatch(/Document discovery|document discovery/i);
    expect(prompt).toMatch(/gap/i);
    expect(prompt).toMatch(/cross-document|cross-doc|consistency/i);
    expect(prompt).toMatch(/interview|question/i);
    expect(prompt).not.toMatch(/use_skill\s*\(\s*["']scribe["']\s*\)/);
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
    expect(shakespearePackage.optionalSkills).toEqual(["style", "philosophy"]);
  });

  test("primaryIntent is docs maintain", () => {
    expect(shakespearePackage.primaryIntent).toMatch(/docs|documentation|PRODUCT|product/i);
  });
});
