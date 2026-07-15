import { describe, expect, test } from "bun:test";
import {
  formatReadFileTimeoutMessage,
  formatSearchTimeoutMessage,
  formatToolExecutionTimeoutMessage,
} from "./tool-time-budget.js";

describe("tool-time-budget messages (intercode)", () => {
  test("grep timeout explains scope vs empty results", () => {
    const msg = formatSearchTimeoutMessage("grep");
    expect(msg).toContain("grep");
    expect(msg).toContain("[timed out before completing]");
    expect(msg).toContain("narrow `path`");
    expect(msg).toContain('not the same as "no matches"');
  });

  test("search_files timeout includes partial paths when provided", () => {
    const msg = formatSearchTimeoutMessage("search_files", "a.ts\nb.ts");
    expect(msg.startsWith("a.ts\nb.ts")).toBe(true);
    expect(msg).toContain("search_files");
    expect(msg).toContain("tighter glob");
  });

  test("tool execution timeout names the tool and budget", () => {
    const msg = formatToolExecutionTimeoutMessage("run_shell", 60_000);
    expect(msg).toContain("run_shell");
    expect(msg).toContain("60000ms");
    expect(msg).toContain("[timed out before completing]");
    expect(msg).toContain("not a normal error");
  });

  test("read_file timeout is distinct from an empty file", () => {
    const msg = formatReadFileTimeoutMessage("/big.log");
    expect(msg).toContain("read_file");
    expect(msg).toContain("/big.log");
    expect(msg).toContain("not an empty file");
  });
});