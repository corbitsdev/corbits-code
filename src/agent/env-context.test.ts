import { describe, expect, test } from "bun:test";

import { buildEnvironmentContext } from "./prompts.js";
import type { EnvironmentInfo } from "./environment.js";

/**
 * <env> cap (CL-10674 P5): the environment block is top-N + count, never the
 * full tree. Git stacks top GIT_STATUS_LINES porcelain lines with an
 * "... and N more" tail; top level caps at TOP_LEVEL_ENTRIES names with an
 * ellipsis tail. This test pins the prompt-side framing so the cap cannot
 * silently regress to a full dump.
 */
const BASE: EnvironmentInfo = {
  cwd: "/repo",
  platform: "Darwin 25.0.0",
  arch: "arm64",
  runtime: "Bun 1.2.0",
  date: new Date("2026-01-15T12:00:00Z"),
  isGitRepo: true,
  gitBranch: "main",
};

describe("environment context cap", () => {
  test("clean tree prints the branch with no status list", () => {
    const env = buildEnvironmentContext(BASE);
    expect(env).toContain("Git: on main, working tree clean");
    expect(env).toContain("<env>");
    expect(env).toContain("</env>");
  });

  test("dirty tree frames top-N + count", () => {
    const env = buildEnvironmentContext({
      ...BASE,
      gitDirtyCount: 42,
      gitStatusSummary: " M src/a.ts\n M src/b.ts",
    });
    expect(env).toContain("Git: on main, 42 uncommitted change(s):");
    expect(env).toContain("M src/a.ts");
    expect(env).toContain("M src/b.ts");
  });

  test("top level caps beyond TOP_LEVEL_ENTRIES with an ellipsis tail", async () => {
    const fs = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { gatherTopLevel } = await import("./environment.js");
    const dir = await fs.mkdtemp(join(tmpdir(), "envtop-"));
    try {
      const writes: Promise<unknown>[] = [];
      for (let i = 0; i < 50; i++) {
        writes.push(fs.writeFile(join(dir, `f${i}.txt`), "x"));
      }
      await Promise.all(writes);
      const topLevel = await gatherTopLevel(dir);
      expect(topLevel).toBeDefined();
      expect((topLevel as string).includes("…")).toBe(true);
      // Top-N framing: 50 entries exceed the 40-entry cap, so at least one
      // leading entry is missing from the shown tail.
      expect((topLevel as string).includes("f49.txt")).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("not a repo prints the not-a-repo line", () => {
    const env = buildEnvironmentContext({ ...BASE, isGitRepo: false });
    expect(env).toContain("Git: not a git repository");
    expect(env).not.toContain("uncommitted change");
  });
});
