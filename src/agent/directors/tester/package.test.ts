import { describe, expect, test } from "bun:test";
import { testerPackage } from "./package.js";

describe("testerPackage", () => {
  test("systemPrompt identity is Tester / TesterDirector (named entity)", () => {
    const p = testerPackage.systemPrompt;
    expect(p).toMatch(/TesterDirector \(Tester\)/);
    expect(p).toMatch(/runtime-verify lane only/i);
    expect(p).not.toMatch(/test director/i);
  });

  test("systemPrompt runs suite/repro and never fixes", () => {
    const p = testerPackage.systemPrompt;
    expect(p).toMatch(/suite\s*\/\s*repro|suite \/ repro/i);
    expect(p).toMatch(/pass\/fail evidence|evidence/i);
    expect(p).toMatch(/never fix|Never fix|do not patch/i);
    expect(p).toContain("re-dispatch to builder or testsmith");
  });

  test("systemPrompt is blinders-on verify lane (not Builder / Testsmith / orchestrator)", () => {
    const p = testerPackage.systemPrompt;
    expect(p).toMatch(/Blinders on/i);
    expect(p).toMatch(/not Builder/i);
    expect(p).toMatch(/not Testsmith/i);
    expect(p).toMatch(/not an orchestrator/i);
    expect(p).toMatch(/Do not design permanent test cases/i);
    expect(p).toMatch(/Do not spawn specialists/i);
  });

  test("systemPrompt has DONE GATE and REPORT MAP for evidence", () => {
    const p = testerPackage.systemPrompt;
    expect(p).toContain("DONE GATE");
    expect(p).toContain("REPORT MAP");
    expect(p).toMatch(/pass \| fail \| blocked/);
    expect(p).toMatch(/commands run|failure excerpts/i);
  });

  test("systemPrompt has no tool-schema restatement or fake caps", () => {
    const p = testerPackage.systemPrompt;
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/fan-out/i);
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/turn budget/i);
    expect(p).not.toMatch(/scheduler/i);
    expect(p).not.toMatch(/no product-mutation tools/i);
    expect(p).not.toMatch(/harness-allowed tools/i);
  });

  test("tools.allow mounts shell and read (lane: never fix)", () => {
    const allow = testerPackage.tools?.allow ?? [];
    expect(allow).toContain("run_shell");
    expect(allow).toContain("read_file");
  });

  test("modelRole is test", () => {
    expect(testerPackage.modelRole).toBe("test");
  });

  test("primaryIntent is suite/repro evidence never fix", () => {
    expect(testerPackage.primaryIntent).toMatch(/suite\/repro|evidence/i);
    expect(testerPackage.primaryIntent).toMatch(/never fix/i);
  });
});
