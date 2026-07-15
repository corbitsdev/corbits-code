import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  runBoundedGrep,
  runBoundedSearchFiles,
} from "./bounded-grep-fallback.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bounded-grep-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("runBoundedGrep", () => {
  test("skips node_modules and returns matches elsewhere", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "src"), { recursive: true });
      await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(dir, "src", "a.ts"), "export const visible = 1;\n");
      await writeFile(join(dir, "node_modules", "pkg", "b.ts"), "export const visible = 2;\n");

      const out = await runBoundedGrep(
        { pattern: "visible", path: ".", max_results: 50 },
        new AbortController().signal,
        dir,
      );
      expect(out).toContain("src/a.ts");
      expect(out).not.toContain("node_modules");
    });
  });

  test("caps match count", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "hits.txt"), "hit\n".repeat(20));
      const out = await runBoundedGrep(
        { pattern: "hit", path: ".", max_results: 3 },
        new AbortController().signal,
        dir,
      );
      expect(out).toContain("(3 of 20 matches shown)");
      const matchLines = out.split("\n").filter((l) => l.includes("hits.txt:"));
      expect(matchLines.length).toBe(3);
    });
  });

  test("caps directory walk", async () => {
    await withTempDir(async (dir) => {
      for (let i = 0; i < 8; i++) {
        await writeFile(join(dir, `f${i}.txt`), `token${i}\n`);
      }
      const out = await runBoundedGrep(
        { pattern: "token", path: ".", max_results: 50 },
        new AbortController().signal,
        dir,
        { maxDirectoryEntries: 3 },
      );
      expect(out).toContain("directory walk capped at 3 files");
    });
  });

  test("does not read entire huge files", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "big.txt"), `${"x".repeat(200_000)}needle\n`);
      const out = await runBoundedGrep(
        { pattern: "needle", path: ".", max_results: 5 },
        new AbortController().signal,
        dir,
        { maxPerFileBytes: 1024 },
      );
      expect(out).toContain("no matches");
    });
  });

  test("respects abort during walk", async () => {
    await withTempDir(async (dir) => {
      for (let i = 0; i < 50; i++) {
        await mkdir(join(dir, `d${i}`), { recursive: true });
        await writeFile(join(dir, `d${i}`, "x.txt"), "needle\n");
      }
      const controller = new AbortController();
      controller.abort();
      await expect(
        runBoundedGrep({ pattern: "needle", path: "." }, controller.signal, dir),
      ).rejects.toThrow();
    });
  });
});

describe("runBoundedSearchFiles", () => {
  test("lists files by glob without node_modules", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "lib"), { recursive: true });
      await mkdir(join(dir, "node_modules"), { recursive: true });
      await writeFile(join(dir, "lib", "keep.ts"), "");
      await writeFile(join(dir, "node_modules", "skip.ts"), "");

      const out = await runBoundedSearchFiles(
        { pattern: "**/*.ts", path: "." },
        new AbortController().signal,
        dir,
      );
      expect(out).toContain("lib/keep.ts");
      expect(out).not.toContain("node_modules");
    });
  });
});

