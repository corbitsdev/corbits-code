import { describe, expect, test } from "bun:test";
import {
  DOCS_TOOLS,
  IMPLEMENT_TOOLS,
  READ_TOOLS,
} from "./tool-sets.js";

describe("DOCS_TOOLS", () => {
  test("excludes run_shell (writePaths gate only locks file writes)", () => {
    expect(DOCS_TOOLS).not.toContain("run_shell");
    expect(DOCS_TOOLS).not.toContain("delete_file");
  });

  test("keeps read/search/lsp/web + file writes", () => {
    const expected: readonly string[] = [
      "read_file",
      "grep",
      "search_files",
      "list_dir",
      "lsp",
      "web_fetch",
      "web_search",
      "write_file",
      "edit_file",
    ];
    for (const tool of expected) {
      expect(DOCS_TOOLS as readonly string[]).toContain(tool);
    }
  });

  test("run_shell stays on the other surfaces", () => {
    for (const surface of [READ_TOOLS, IMPLEMENT_TOOLS]) {
      expect(surface).toContain("run_shell");
    }
  });
});
