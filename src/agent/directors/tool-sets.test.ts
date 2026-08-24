import { describe, expect, test } from "bun:test";
import {
  DOCS_TOOLS,
  BUILD_TOOLS,
  ORCHESTRATOR_TOOLS,
  PRODUCT_WRITE_TOOLS,
  READ_TOOLS,
  REVIEW_TOOLS,
  INTERN_TOOLS,
  SKYWALKER_TOOLS,
} from "./tool-sets.js";

describe("PRODUCT_WRITE_TOOLS", () => {
  test("is write_file / edit_file / delete_file", () => {
    expect([...PRODUCT_WRITE_TOOLS]).toEqual(["write_file", "edit_file", "delete_file"]);
  });
});

describe("READ_TOOLS", () => {
  test("stays read-only (no path mutation)", () => {
    for (const name of PRODUCT_WRITE_TOOLS) {
      expect(READ_TOOLS as readonly string[]).not.toContain(name);
    }
  });
});

describe("DOCS_TOOLS", () => {
  test("excludes run_shell as envelope policy; includes delete_file", () => {
    expect(DOCS_TOOLS).not.toContain("run_shell");
    expect(DOCS_TOOLS).toContain("delete_file");
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
      "delete_file",
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
  test("both mount product writes and task", () => {
    for (const name of PRODUCT_WRITE_TOOLS) {
      expect(SKYWALKER_TOOLS as readonly string[]).toContain(name);
      expect(ORCHESTRATOR_TOOLS as readonly string[]).toContain(name);
    }
    expect(SKYWALKER_TOOLS).toContain("task");
    expect(ORCHESTRATOR_TOOLS).toContain("task");
  });
});

describe("REVIEW_TOOLS / INTERN_TOOLS", () => {
  test("compose PRODUCT_WRITE_TOOLS", () => {
    for (const name of PRODUCT_WRITE_TOOLS) {
      expect(REVIEW_TOOLS as readonly string[]).toContain(name);
      expect(INTERN_TOOLS as readonly string[]).toContain(name);
    }
  });

  test("intern stays shell-first without grep/search/task", () => {
    expect(INTERN_TOOLS).toContain("run_shell");
    expect(INTERN_TOOLS).toContain("read_file");
    expect(INTERN_TOOLS).toContain("list_dir");
    for (const name of ["grep", "search_files", "task"] as const) {
      expect(INTERN_TOOLS as readonly string[]).not.toContain(name);
    }
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

  test("review/orchestrator/intern do not mount apply_patch", () => {
    for (const surface of [REVIEW_TOOLS, ORCHESTRATOR_TOOLS, INTERN_TOOLS]) {
      expect(surface as readonly string[]).not.toContain("apply_patch");
    }
  });
});
