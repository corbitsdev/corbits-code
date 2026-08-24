import { describe, expect, test } from "bun:test";
import {
  AUTO_ALLOW_READ_TOOLS,
  PATH_KEYED_READ_TOOLS,
  SEARCH_QUERY_TOOLS,
} from "./tool-classification.js";

// Pins membership so a future edit to any of these sets — or to the director
// READ_TOOLS they derive from — fails CI instead of silently drifting one
// call site out of sync with the others (CL-6809).
describe("AUTO_ALLOW_READ_TOOLS", () => {
  test("gates auto-allow with exactly this membership", () => {
    expect([...AUTO_ALLOW_READ_TOOLS].sort()).toEqual(
      ["grep", "list_dir", "lsp", "manage_tasks", "read_file", "search_files"].sort(),
    );
  });

  test("excludes tools with their own, narrower auto-allow logic", () => {
    for (const tool of ["run_shell", "web_fetch", "web_search"]) {
      expect(AUTO_ALLOW_READ_TOOLS.has(tool)).toBe(false);
    }
  });
});

describe("PATH_KEYED_READ_TOOLS", () => {
  test("is read_file only", () => {
    expect([...PATH_KEYED_READ_TOOLS]).toEqual(["read_file"]);
  });
});

describe("SEARCH_QUERY_TOOLS", () => {
  test("is grep and search_files only", () => {
    expect([...SEARCH_QUERY_TOOLS].sort()).toEqual(["grep", "search_files"]);
  });
});
