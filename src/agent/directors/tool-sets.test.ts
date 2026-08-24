import { describe, expect, test } from "bun:test";
import {
  DOCS_TOOLS,
  BUILD_TOOLS,
  ORCHESTRATOR_TOOLS,
  READ_TOOLS,
  SKYWALKER_TOOLS,
} from "./tool-sets.js";

describe("DOCS_TOOLS", () => {
  test("excludes run_shell and delete_file as envelope policy", () => {
    expect(DOCS_TOOLS).not.toContain("run_shell");
    expect(DOCS_TOOLS).not.toContain("delete_file");
  });

  test("keeps read/search/lsp/web + file writes + apply_patch", () => {
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
      "apply_patch",
    ];
    for (const tool of expected) {
      expect(DOCS_TOOLS as readonly string[]).toContain(tool);
    }
  });

  test("run_shell stays on the other surfaces", () => {
    for (const surface of [READ_TOOLS, BUILD_TOOLS]) {
      expect(surface).toContain("run_shell");
    }
  });

  test("excludes the shell proxy (no run_shell) but keeps update_plan", () => {
    expect(DOCS_TOOLS).not.toContain("shell");
    expect(DOCS_TOOLS).toContain("update_plan");
  });
});

describe("SKYWALKER_TOOLS / ORCHESTRATOR_TOOLS", () => {
  test("Skywalker mounts product writes; greybeard orchestrator surface does not", () => {
    for (const name of ["write_file", "edit_file", "delete_file"] as const) {
      expect(SKYWALKER_TOOLS as readonly string[]).toContain(name);
      expect(ORCHESTRATOR_TOOLS as readonly string[]).not.toContain(name);
    }
    expect(SKYWALKER_TOOLS).toContain("task");
    expect(ORCHESTRATOR_TOOLS).toContain("task");
  });

  test("search_agents is Skywalker-only; nested orchestrator surface omits discovery", () => {
    expect(SKYWALKER_TOOLS).toContain("search_agents");
    expect(ORCHESTRATOR_TOOLS as readonly string[]).not.toContain("search_agents");
  });
});

describe("BUILD_TOOLS", () => {
  test("includes apply_patch alongside path mutation tools", () => {
    expect(BUILD_TOOLS).toContain("write_file");
    expect(BUILD_TOOLS).toContain("edit_file");
    expect(BUILD_TOOLS).toContain("delete_file");
    expect(BUILD_TOOLS).toContain("apply_patch");
  });

  test("includes the Codex shell and update_plan proxy names", () => {
    expect(BUILD_TOOLS).toContain("shell");
    expect(BUILD_TOOLS).toContain("update_plan");
  });
});
