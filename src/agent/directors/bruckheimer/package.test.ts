import { describe, expect, test } from "bun:test";
import { bruckheimerPackage } from "./package.js";

describe("bruckheimerPackage", () => {
  test("tools.allow has no shell", () => {
    const allow = bruckheimerPackage.tools?.allow ?? [];
    expect(allow).not.toContain("run_shell");
  });

  test("modelRole is docs", () => {
    expect(bruckheimerPackage.modelRole).toBe("docs");
  });

  test("primaryIntent and outOfLane match discovery lane", () => {
    expect(bruckheimerPackage.primaryIntent).toMatch(/product discovery/i);
    expect(bruckheimerPackage.outOfLane).toContain("shipping product code");
    expect(bruckheimerPackage.outOfLane).toContain("architecture gates");
    expect(bruckheimerPackage.outOfLane).toContain(
      "ongoing P/A/I docs maintenance as Shakespeare",
    );
    expect(bruckheimerPackage.outOfLane).toContain(
      "ordered eng plans as Counsel",
    );
  });
});
