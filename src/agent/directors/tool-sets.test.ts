import { describe, expect, test } from "bun:test";
import {
  DOCS_TOOLS,
  IMPLEMENT_TOOLS,
  ORCHESTRATOR_TOOLS,
  READ_TOOLS,
  SKYWALKER_TOOLS,
} from "./tool-sets.js";

describe("DOCS_TOOLS", () => {
  test("excludes run_shell and delete_file as envelope policy", () => {
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

describe("SKYWALKER_TOOLS", () => {
  test("mounts writes and dispatch; greybeard orchestrator surface does not write", () => {
    expect(SKYWALKER_TOOLS).toEqual(
      expect.arrayContaining(["write_file", "edit_file", "delete_file", "task", "search_agents"]),
    );
    expect(ORCHESTRATOR_TOOLS).not.toContain("write_file");
    expect(ORCHESTRATOR_TOOLS).toContain("task");
  });
});
