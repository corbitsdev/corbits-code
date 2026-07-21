import { describe, test, expect } from "bun:test";
import { isExitCommand } from "./exit-command.js";

describe("isExitCommand", () => {
  test("bare exit and quit match", () => {
    expect(isExitCommand("exit")).toBe(true);
    expect(isExitCommand("quit")).toBe(true);
  });

  test("case and surrounding whitespace are ignored", () => {
    expect(isExitCommand("  Exit ")).toBe(true);
    expect(isExitCommand("QUIT")).toBe(true);
    expect(isExitCommand("\nquit\n")).toBe(true);
  });

  test("messages that merely contain the word do not match", () => {
    expect(isExitCommand("exit the loop early")).toBe(false);
    expect(isExitCommand("how do I quit vim")).toBe(false);
    expect(isExitCommand("quit!")).toBe(false);
  });

  test("empty input does not match", () => {
    expect(isExitCommand("")).toBe(false);
    expect(isExitCommand("   ")).toBe(false);
  });
});
