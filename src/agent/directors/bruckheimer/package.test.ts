import { describe, expect, test } from "bun:test";
import { bruckheimerPackage } from "./package.js";

describe("bruckheimerPackage", () => {
  test("id matches directory (keep bruckheimer path; identity is Bruckheimer)", () => {
    expect(bruckheimerPackage.id).toBe("bruckheimer");
  });

  test("systemPrompt is real (not Placeholder)", () => {
    expect(bruckheimerPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(bruckheimerPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(bruckheimerPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
  });

  test("systemPrompt identity is Bruckheimer / BruckheimerDirector", () => {
    const p = bruckheimerPackage.systemPrompt;
    expect(p).toMatch(/BruckheimerDirector \(Bruckheimer\)/);
    expect(p).toMatch(/product-discovery lane only/i);
    expect(p).not.toMatch(/ProductDiscoveryDirector/);
  });

  test("systemPrompt keeps gaas producer voice (audience, hook, win, money bar)", () => {
    const p = bruckheimerPackage.systemPrompt;
    expect(p).toMatch(/You are a producer/i);
    expect(p).toMatch(/The audience/i);
    expect(p).toMatch(/The hook/i);
    expect(p).toMatch(/The win/i);
    expect(p).toMatch(/shared glossary/i);
    expect(p).toMatch(/who pays, who uses, what gets shipped/);
    expect(p).toMatch(/Not greed — survival/);
    expect(p).toMatch(/do not write a brief for it/i);
  });

  test("systemPrompt teaches brief structure and briefs/ handoff", () => {
    const p = bruckheimerPackage.systemPrompt;
    expect(p).toMatch(/One-liner/);
    expect(p).toMatch(/Definition of success/);
    expect(p).toMatch(/In scope for v1/);
    expect(p).toMatch(/Explicitly out of scope/);
    expect(p).toMatch(/Open risks and unresolved decisions/);
    expect(p).toMatch(/Glossary/);
    expect(p).toMatch(/briefs\//);
  });

  test("systemPrompt adapts AskUserQuestion to ask_operator with prose fallback", () => {
    const p = bruckheimerPackage.systemPrompt;
    expect(p).toMatch(/ask_operator/);
    expect(p).not.toMatch(/AskUserQuestion/);
    expect(p).toMatch(/not mounted on this session/i);
    expect(p).toMatch(/ask the clarifying question in prose/i);
  });

  test("systemPrompt uses Corbits file tools (not Read/Write/Bash)", () => {
    const p = bruckheimerPackage.systemPrompt;
    expect(p).toMatch(/read_file/);
    expect(p).toMatch(/write_file/);
    expect(p).toMatch(/edit_file/);
    expect(p).toMatch(/search_files/);
    expect(p).not.toMatch(/\bAskUserQuestion\b/);
    expect(p).not.toMatch(/Use Read and Write/);
    expect(p).not.toMatch(/Use Bash sparingly/);
  });

  test("systemPrompt is leaf lane (no spawn / implement claims)", () => {
    const p = bruckheimerPackage.systemPrompt;
    expect(p).toMatch(/Do not spawn specialists/i);
    expect(p).toMatch(/do not implement/i);
    expect(p).toMatch(/not Builder/i);
    expect(p).toMatch(/not Shakespeare/i);
    expect(p).toMatch(/not Counsel/i);
    expect(p).toMatch(/not Greybeard/i);
    expect(p).toMatch(/not Critic/i);
    expect(p).toMatch(/not an orchestrator/i);
    expect(p).not.toMatch(/spawn_agent/);
    expect(p).not.toMatch(/maySpawn:\s*true/);
  });

  test("systemPrompt teaches worker report shape Summary/Findings/Blockers/Paths", () => {
    const p = bruckheimerPackage.systemPrompt;
    expect(p).toContain("## Summary");
    expect(p).toContain("## Findings");
    expect(p).toContain("## Blockers");
    expect(p).toContain("## Paths");
    expect(p).toMatch(/brief file you wrote/i);
    expect(p).toContain("DONE GATE");
  });

  test("systemPrompt has no emoji and no tool-schema restatement", () => {
    const p = bruckheimerPackage.systemPrompt;
    expect(p).toMatch(/You do not use emojis/);
    expect(p).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/Write tools are mounted/i);
    expect(p).not.toMatch(/path lock/i);
    expect(p).not.toMatch(/via run_shell/i);
  });

  test("spawn.maySpawn is false", () => {
    expect(bruckheimerPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow is DOCS_TOOLS surface (writes, no shell)", () => {
    const allow = bruckheimerPackage.tools?.allow ?? [];
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
    expect(allow).not.toContain("run_shell");
  });

  test("modelRole is docs", () => {
    expect(bruckheimerPackage.modelRole).toBe("docs");
  });

  test("tier is leaf", () => {
    expect(bruckheimerPackage.tier).toBe("leaf");
  });

  test("primaryIntent and outOfLane match discovery lane", () => {
    expect(bruckheimerPackage.primaryIntent).toMatch(/product discovery/i);
    expect(bruckheimerPackage.outOfLane).toContain("shipping product code");
    expect(bruckheimerPackage.outOfLane).toContain("architecture gates");
    expect(bruckheimerPackage.outOfLane).toContain("ongoing P/A/I docs maintenance as Shakespeare");
    expect(bruckheimerPackage.outOfLane).toContain("ordered eng plans as Counsel");
  });
});
