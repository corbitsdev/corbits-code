import { describe, expect, test } from "bun:test";
import {
  DOCS_TOOLS,
  BUILD_TOOLS,
  ORCHESTRATOR_TOOLS,
  PRODUCT_WRITE_TOOLS,
  READ_TOOLS,
  REVIEW_TOOLS,
  SKILL_TOOLS,
  DISPATCH_TOOLS,
} from "./tool-sets.js";

describe("PRODUCT_WRITE_TOOLS", () => {
  test("is write_file / edit_file / delete_file", () => {
    expect([...PRODUCT_WRITE_TOOLS]).toEqual([
      "write_file",
      "edit_file",
      "delete_file",
    ]);
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
      "delete_file",
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

  test("omits Codex native names", () => {
    expect(DOCS_TOOLS as readonly string[]).not.toContain("shell");
    expect(DOCS_TOOLS as readonly string[]).not.toContain("update_plan");
    expect(DOCS_TOOLS as readonly string[]).not.toContain("apply_patch");
  });
});

describe("DISPATCH_TOOLS / ORCHESTRATOR_TOOLS", () => {
  test("both mount product writes and split fleet tools", () => {
    for (const name of PRODUCT_WRITE_TOOLS) {
      expect(DISPATCH_TOOLS as readonly string[]).toContain(name);
      expect(DISPATCH_TOOLS as readonly string[]).toContain(name);
      expect(ORCHESTRATOR_TOOLS as readonly string[]).toContain(name);
    }
    for (const name of ["spawn_agent"] as const) {
      expect(DISPATCH_TOOLS as readonly string[]).toContain(name);
      expect(DISPATCH_TOOLS as readonly string[]).toContain(name);
      expect(ORCHESTRATOR_TOOLS as readonly string[]).toContain(name);
    }
    for (const surface of [DISPATCH_TOOLS, ORCHESTRATOR_TOOLS] as const) {
      expect(surface as readonly string[]).not.toContain("wait_agents");
      expect(surface as readonly string[]).not.toContain("task");
    }
  });

  // Fleet discovery is Tier-1 only.
  test("search_agents is on Dispatch only, not the nested orchestrator surface", () => {
    expect(DISPATCH_TOOLS as readonly string[]).toContain("search_agents");
    expect(DISPATCH_TOOLS as readonly string[]).toContain("search_agents");
    expect(ORCHESTRATOR_TOOLS as readonly string[]).not.toContain(
      "search_agents",
    );
  });

  test("skill_search + use_skill mount on every worker surface, never ask_operator", () => {
    expect([...SKILL_TOOLS]).toEqual(["skill_search", "use_skill"]);
    for (const surface of [
      READ_TOOLS,
      BUILD_TOOLS,
      DOCS_TOOLS,
      REVIEW_TOOLS,
      ORCHESTRATOR_TOOLS,
      DISPATCH_TOOLS,
    ] as const) {
      expect(surface as readonly string[]).toContain("skill_search");
      expect(surface as readonly string[]).toContain("use_skill");
      expect(surface as readonly string[]).not.toContain("ask_operator");
    }
  });

  test("no surface lists a tool twice (SKILL_TOOLS spread once via READ_TOOLS)", () => {
    for (const surface of [
      READ_TOOLS,
      BUILD_TOOLS,
      DOCS_TOOLS,
      REVIEW_TOOLS,
      ORCHESTRATOR_TOOLS,
      DISPATCH_TOOLS,
    ] as const) {
      const names = surface as readonly string[];
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe("REVIEW_TOOLS", () => {
  test("composes PRODUCT_WRITE_TOOLS", () => {
    for (const name of PRODUCT_WRITE_TOOLS) {
      expect(REVIEW_TOOLS as readonly string[]).toContain(name);
    }
  });
});

describe("BUILD_TOOLS", () => {
  test("includes path mutation tools and omits Codex natives", () => {
    expect(BUILD_TOOLS).toContain("write_file");
    expect(BUILD_TOOLS).toContain("edit_file");
    expect(BUILD_TOOLS).toContain("delete_file");
    expect(BUILD_TOOLS as readonly string[]).not.toContain("apply_patch");
    expect(BUILD_TOOLS as readonly string[]).not.toContain("shell");
    expect(BUILD_TOOLS as readonly string[]).not.toContain("update_plan");
  });

  test("review and orchestrator do not list apply_patch", () => {
    for (const surface of [REVIEW_TOOLS, ORCHESTRATOR_TOOLS]) {
      expect(surface as readonly string[]).not.toContain("apply_patch");
    }
  });
});
