import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPosixTools } from "@intx/tools-posix";
import { mapSearchBudgetOutcome } from "./shell-guard-plugin.js";
import { BUDGET_EXPIRED } from "../util/budget-race.js";
import {
  formatUnboundedSearchMessage,
  isUnboundedRootSearch,
  TIMEOUT_PREFIX,
} from "./tool-time-budget.js";
import { ripgrepPlugin } from "./ripgrep-plugin.js";
import type { RgChild, SpawnRg } from "./rg-run.js";

/**
 * CL-9469: search_files must fail closed on unbounded root walks instead of
 * timing out. A workspace-root search with a recursive glob refuses up front
 * with scope guidance; bounded searches still return hits.
 */

async function withFixture(
  run: (paths: { cwd: string; sub: string }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "cl9469-search-scope-"));
  const sub = join(cwd, "sub");
  try {
    await mkdir(join(sub, "nested"), { recursive: true });
    await mkdir(join(cwd, "node_modules"), { recursive: true });
    await writeFile(join(cwd, "top.ts"), "export const top = 1;\n");
    await writeFile(join(sub, "keep.ts"), "export const keep = 1;\n");
    await writeFile(join(sub, "nested", "deep.ts"), "export const deep = 1;\n");
    await writeFile(
      join(cwd, "node_modules", "skip.ts"),
      "export const s = 1;\n",
    );
    await run({ cwd, sub });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function throwingSpawn(calls: string[][]): SpawnRg {
  return (args) => {
    calls.push(args);
    throw new Error("search must not walk: rg must not spawn");
  };
}

// rg absent: the ENOENT error event is exactly what runRg treats as
// "rg not installed" ({ kind: "unavailable" } -> fallback walker leg).
function rgMissingSpawn(): SpawnRg {
  return () => ({
    pid: undefined,
    stdout: { on: () => undefined },
    stderr: { on: () => undefined },
    on: ((event: string, listener: (arg: never) => void) => {
      if (event === "error") {
        const err = Object.assign(new Error("spawn rg ENOENT"), {
          code: "ENOENT",
        });
        queueMicrotask(() => listener(err as never));
      }
    }) as RgChild["on"],
    kill: () => undefined,
  });
}

describe("CL-9469 search_files fails closed on unbounded root walks", () => {
  test("root recursive glob is refused with scope guidance, not a walk", async () => {
    await withFixture(async ({ cwd }) => {
      const spawnCalls: string[][] = [];
      const tools = createPosixTools({
        cwd,
        plugins: [ripgrepPlugin(cwd, {}, throwingSpawn(spawnCalls))],
      });
      const started = Date.now();
      const result = await tools.run(
        { id: "1", name: "search_files", arguments: { pattern: "**/*.ts" } },
        new AbortController().signal,
      );
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(spawnCalls.length).toBe(0);
      expect(result.isError).toBe(true);
      expect(String(result.content)).toContain("narrow `path`");
      expect(String(result.content)).toContain("glob");
      expect(String(result.content)).toContain("not the same as");
      expect(String(result.content)).not.toContain(
        "[timed out before completing]",
      );
    });
  });

  test("explicit root path with recursive glob is refused the same way", async () => {
    await withFixture(async ({ cwd }) => {
      const spawnCalls: string[][] = [];
      const tools = createPosixTools({
        cwd,
        plugins: [ripgrepPlugin(cwd, {}, throwingSpawn(spawnCalls))],
      });
      for (const path of [".", cwd]) {
        const result = await tools.run(
          {
            id: "1",
            name: "search_files",
            arguments: { pattern: "**/*.ts", path },
          },
          new AbortController().signal,
        );
        expect(spawnCalls.length).toBe(0);
        expect(result.isError).toBe(true);
        expect(String(result.content)).toContain("narrow `path`");
      }
    });
  });

  test("bare star at the root is refused", async () => {
    await withFixture(async ({ cwd }) => {
      const spawnCalls: string[][] = [];
      const tools = createPosixTools({
        cwd,
        plugins: [ripgrepPlugin(cwd, {}, throwingSpawn(spawnCalls))],
      });
      const result = await tools.run(
        { id: "1", name: "search_files", arguments: { pattern: "*" } },
        new AbortController().signal,
      );
      expect(spawnCalls.length).toBe(0);
      expect(result.isError).toBe(true);
      expect(String(result.content)).toContain("narrow `path`");
    });
  });

  test("scoped subdirectory recursive glob still returns hits", async () => {
    await withFixture(async ({ cwd, sub }) => {
      for (const spawn of [undefined, rgMissingSpawn()] as const) {
        const tools = createPosixTools({
          cwd,
          plugins: [ripgrepPlugin(cwd, {}, spawn)],
        });
        const result = await tools.run(
          {
            id: "1",
            name: "search_files",
            arguments: { pattern: "**/*.ts", path: sub },
          },
          new AbortController().signal,
        );
        expect(result.isError !== true).toBe(true);
        expect(String(result.content)).toContain("keep.ts");
        expect(String(result.content)).toContain("deep.ts");
      }
    });
  });

  test("tight glob at the root still returns hits", async () => {
    await withFixture(async ({ cwd }) => {
      for (const spawn of [undefined, rgMissingSpawn()] as const) {
        const tools = createPosixTools({
          cwd,
          plugins: [ripgrepPlugin(cwd, {}, spawn)],
        });
        const result = await tools.run(
          {
            id: "1",
            name: "search_files",
            arguments: { pattern: "*.ts" },
          },
          new AbortController().signal,
        );
        expect(result.isError !== true).toBe(true);
        expect(String(result.content)).toContain("top.ts");
      }
    });
  });

  test("recursive glob pinned to a literal dir at the root is allowed", async () => {
    await withFixture(async ({ cwd }) => {
      for (const spawn of [undefined, rgMissingSpawn()] as const) {
        const tools = createPosixTools({
          cwd,
          plugins: [ripgrepPlugin(cwd, {}, spawn)],
        });
        const result = await tools.run(
          {
            id: "1",
            name: "search_files",
            arguments: { pattern: "sub/**/*.ts" },
          },
          new AbortController().signal,
        );
        expect(result.isError !== true).toBe(true);
        expect(String(result.content)).toContain("keep.ts");
        expect(String(result.content)).toContain("deep.ts");
      }
    });
  });

  test("root dot-relative recursive glob is refused, not walked", async () => {
    await withFixture(async ({ cwd }) => {
      const spawnCalls: string[][] = [];
      const tools = createPosixTools({
        cwd,
        plugins: [ripgrepPlugin(cwd, {}, throwingSpawn(spawnCalls))],
      });
      const started = Date.now();
      const result = await tools.run(
        { id: "1", name: "search_files", arguments: { pattern: "./**/*.ts" } },
        new AbortController().signal,
      );
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(spawnCalls.length).toBe(0);
      expect(result.isError).toBe(true);
      expect(String(result.content)).toContain("narrow `path`");
      expect(String(result.content)).toContain("glob");
      expect(String(result.content)).not.toContain(TIMEOUT_PREFIX);
    });
  });

  test("interior-dotdot collapse to the root is refused, not walked", async () => {
    await withFixture(async ({ cwd }) => {
      const spawnCalls: string[][] = [];
      const tools = createPosixTools({
        cwd,
        plugins: [ripgrepPlugin(cwd, {}, throwingSpawn(spawnCalls))],
      });
      const started = Date.now();
      const result = await tools.run(
        {
          id: "1",
          name: "search_files",
          arguments: { pattern: "a/../**/*.ts" },
        },
        new AbortController().signal,
      );
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(spawnCalls.length).toBe(0);
      expect(result.isError).toBe(true);
      expect(String(result.content)).toContain("narrow `path`");
      expect(String(result.content)).toContain("glob");
      expect(String(result.content)).not.toContain(TIMEOUT_PREFIX);
    });
  });
});

describe("CL-9469 unbounded-root predicate", () => {
  const cwd = "/repo/root";
  test("omitted, empty, dot, and root paths count as the workspace root", () => {
    for (const path of [undefined, "", ".", "./", "/repo/root"]) {
      expect(isUnboundedRootSearch({ path, pattern: "**/*.ts", cwd })).toBe(
        true,
      );
    }
  });
  test("subdirectories and non-filesystem targets are not the root", () => {
    for (const path of [
      "sub",
      "sub/nested",
      "/elsewhere",
      "archive:///x",
      "tool-output:///y",
    ]) {
      expect(isUnboundedRootSearch({ path, pattern: "**/*.ts", cwd })).toBe(
        false,
      );
    }
  });
  test("tight globs stay allowed at the root", () => {
    for (const pattern of ["*.ts", "*config*", "README.md", "*.{ts,tsx}"]) {
      expect(isUnboundedRootSearch({ path: undefined, pattern, cwd })).toBe(
        false,
      );
    }
  });
  test("bare star counts as unbounded", () => {
    expect(isUnboundedRootSearch({ path: undefined, pattern: "*", cwd })).toBe(
      true,
    );
  });
  // A recursive descent is only a whole-tree walk when nothing literal pins it
  // down; a leading literal dir keeps it bounded even at the workspace root.
  test("recursive glob with a leading literal dir is bounded", () => {
    for (const pattern of [
      "src/**/*.ts",
      "packages/a/src/**/*.ts",
      "docs/**",
      "sub/**",
      "src.v2/**",
    ]) {
      expect(isUnboundedRootSearch({ path: undefined, pattern, cwd })).toBe(
        false,
      );
    }
  });
  test("recursive descent with no leading literal dir stays unbounded", () => {
    for (const pattern of ["**", "**/*.ts", "**/*", "/**/*.ts"]) {
      expect(isUnboundedRootSearch({ path: undefined, pattern, cwd })).toBe(
        true,
      );
    }
  });
  // F1 soundness hole: `.`/`..` are relative-notation, not literal pins, so a
  // leading dot segment must not whitelist a root walk (`./**`, `./**/*.ts`)
  // and `..` must not be readable as an anchored workspace-escape.
  test("leading dot or dotdot is not a literal pin", () => {
    for (const pattern of [
      "./**",
      "./**/*.ts",
      "./src/**",
      "../**",
      "../src/**",
    ]) {
      expect(isUnboundedRootSearch({ path: undefined, pattern, cwd })).toBe(
        true,
      );
    }
  });
  // F3 soundness hole: interior `..` collapse must be normalized, not read
  // verbatim. `a/../**` collapses to `./**` (root-wide walk), `src/../../**`
  // pops above the workspace root (escape), and `./a/../**` is still root
  // relative. Only a prefix that collapses to a surviving name-bearing pin
  // (`src/../packages/**` -> `packages/**`) stays bounded.
  test("interior dotdot collapse is normalized, so the pin must survive", () => {
    for (const pattern of [
      "a/../**",
      "src/../../**",
      "./a/../**",
      "a/../**/*.ts",
    ]) {
      expect(isUnboundedRootSearch({ path: undefined, pattern, cwd })).toBe(
        true,
      );
    }
    for (const pattern of [
      "a/./**",
      "a//**",
      "src/../packages/**",
      "*/src/**",
    ]) {
      expect(isUnboundedRootSearch({ path: undefined, pattern, cwd })).toBe(
        false,
      );
    }
  });
  test("refusal message carries scope guidance and never reads as a timeout", () => {
    const message = formatUnboundedSearchMessage("search_files", "**/*.ts");
    expect(message).toContain("narrow `path`");
    expect(message).toContain("glob");
    expect(message).toContain("not the same as");
    expect(message).not.toContain(TIMEOUT_PREFIX);
    // Shell-guard maps /abort/i errors to timeouts when its budget fires;
    // refusal must flow through untouched.
    expect(message).not.toMatch(/abort/i);
  });
});

describe("CL-9469 timeout path is never empty success", () => {
  test("budget expiry is an explicit timeout error, not empty results", () => {
    const result = mapSearchBudgetOutcome("1", "search_files", BUDGET_EXPIRED, {
      budgetAborted: true,
      parentAborted: false,
    });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain(TIMEOUT_PREFIX);
    expect(String(result.content)).toContain("narrow `path`");
    expect(String(result.content)).toContain("not the same as");
  });
  test("parent abort during the race reads as aborted, not a timeout", () => {
    const result = mapSearchBudgetOutcome("1", "grep", BUDGET_EXPIRED, {
      budgetAborted: true,
      parentAborted: true,
    });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("aborted");
    expect(String(result.content)).not.toContain(TIMEOUT_PREFIX);
  });
  test("timeout error from an inner plugin passes through as an error", () => {
    const inner = {
      callId: "1",
      content: `grep ${TIMEOUT_PREFIX} — narrow down`,
      isError: true,
    } as const;
    const result = mapSearchBudgetOutcome("1", "grep", inner, {
      budgetAborted: true,
      parentAborted: false,
    });
    expect(result).toBe(inner);
    expect(result.isError).toBe(true);
  });
  test("generic abort torn down by the budget becomes a timeout error", () => {
    const result = mapSearchBudgetOutcome(
      "1",
      "search_files",
      { callId: "1", content: "aborted", isError: true },
      { budgetAborted: true, parentAborted: false },
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain(TIMEOUT_PREFIX);
  });
  test("genuine empty success passes through untouched", () => {
    const empty = {
      callId: "1",
      content: 'no files matching "*.zzz-nope"',
    } as const;
    const result = mapSearchBudgetOutcome("1", "search_files", empty, {
      budgetAborted: false,
      parentAborted: false,
    });
    expect(result).toBe(empty);
    expect(result.isError !== true).toBe(true);
    expect(String(result.content)).not.toContain(TIMEOUT_PREFIX);
  });
});
