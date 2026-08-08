import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { ripgrepPlugin } from "../../src/plugins/ripgrep-plugin.js";
import { resultTruncationPlugin } from "../../src/plugins/result-truncation-plugin.js";
import type { RgChild, SpawnRg } from "../../src/plugins/rg-run.js";

// Repo root derived from this file, not process.cwd(): these cases search real
// repo paths, so they must not depend on where the runner was invoked from.
const cwd = join(import.meta.dirname, "../..");
const fallback = async (): Promise<ToolResult> => ({ callId: "c", content: "FALLBACK", isError: true });

function run(
  call: ToolCall,
  limits: { timeoutMs?: number; maxOutputBytes?: number } = {},
  spawnChild?: SpawnRg,
): Promise<ToolResult> {
  const handler = ripgrepPlugin(cwd, limits, spawnChild).middleware!(fallback);
  return handler(call, new AbortController().signal);
}

// A child that never emits data or closes, so the timeout is the only path
// to settlement — the trigger the timeout test needs, not a race against how
// fast a real ripgrep process happens to run.
const stalledSpawn: SpawnRg = (): RgChild => ({
  pid: undefined,
  stdout: { on: () => undefined },
  stderr: { on: () => undefined },
  on: (() => undefined) as RgChild["on"],
  kill: () => undefined,
});

// A child whose stdout is scripted directly, bypassing a real `rg` process
// (and its own --max-count filtering) so the byte cap and the line-count cap
// can both be forced to fire on the same run.
function scriptedSpawn(stdout: string, code: number | null): SpawnRg {
  return () => {
    let onData: ((chunk: unknown) => void) | undefined;
    let onClose: ((code: number | null) => void) | undefined;
    const child: RgChild = {
      pid: undefined,
      stdout: {
        on: (_event, listener) => {
          onData = listener;
        },
      },
      stderr: { on: () => undefined },
      on: ((event: string, listener: (arg: never) => void) => {
        if (event === "close") onClose = listener as (code: number | null) => void;
      }) as RgChild["on"],
      kill: () => undefined,
    };
    queueMicrotask(() => {
      onData?.(stdout);
      onClose?.(code);
    });
    return child;
  };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ripgrep-plugin-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("grep routes through ripgrep and returns matches", async () => {
  const result = await run({
    id: "c",
    name: "grep",
    arguments: { pattern: "ripgrepPlugin", path: "src/plugins" },
  });
  expect(result.content).not.toBe("FALLBACK");
  expect(result.isError).toBeUndefined();
  expect(result.content).toContain("ripgrepPlugin");
});

test("grep reports no matches without falling back", async () => {
  const result = await run({
    id: "c",
    name: "grep",
    arguments: { pattern: "zzz_no_such_symbol_zzz", path: "src/plugins" },
  });
  expect(result.content).toContain("no matches");
  expect(result.isError).toBeUndefined();
});

test("search_files routes through ripgrep and lists files", async () => {
  const result = await run({
    id: "c",
    name: "search_files",
    arguments: { pattern: "ripgrep-plugin.ts", path: "src" },
  });
  expect(result.content).not.toBe("FALLBACK");
  expect(result.content).toContain("ripgrep-plugin.ts");
});

test("unrelated tools fall through to the next handler", async () => {
  const result = await run({ id: "c", name: "read_file", arguments: { path: "x" } });
  expect(result.content).toBe("FALLBACK");
});

test("grep returns partial matches when the output byte cap is hit", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "big.txt"), "match line here\n".repeat(5000));
    const result = await run(
      {
        id: "c",
        name: "grep",
        arguments: { pattern: "match", path: dir, max_results: 5000 },
      },
      { maxOutputBytes: 200 },
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("match line here");
    expect(String(result.content).length).toBeLessThanOrEqual(200);
  });
});

// Hosts without ripgrep take the pure-TypeScript walker instead, and the cap has
// to hold there too — a CI runner with no `rg` is how this went unnoticed.
async function withoutRipgrep(body: () => Promise<void>): Promise<void> {
  const path = process.env.PATH;
  process.env.PATH = "";
  try {
    await body();
  } finally {
    process.env.PATH = path;
  }
}

test("the output byte cap holds when ripgrep is unavailable", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "big.txt"), "match line here\n".repeat(5000));
    await withoutRipgrep(async () => {
      const result = await run(
        { id: "c", name: "grep", arguments: { pattern: "match", path: dir, max_results: 5000 } },
        { maxOutputBytes: 200 },
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("match line here");
      expect(String(result.content).length).toBeLessThan(400);
    });
  });
});

// A grep run that both breaches the byte cap (rg-output.ts) and matches more
// lines than max_results (ripgrep-plugin.ts's own count cap) used to carry
// two notices: capLines added its own "(showing first N of M+ lines...)"
// text on top of whatever the byte-cap breach had already reported, because
// partialContent concatenated both unconditionally. It must report the
// truncation exactly once.
test("a grep result that hits both the byte cap and the match-count cap carries exactly one truncation notice", async () => {
  // 400 matched lines emitted directly, bypassing a real `rg` process so
  // nothing upstream of ripgrep-plugin.ts pre-limits the line count.
  const result = await run(
    { id: "c", name: "grep", arguments: { pattern: "match", path: cwd, max_results: 3 } },
    { maxOutputBytes: 200 },
    scriptedSpawn("big.txt:1:match line here\n".repeat(400), 0),
  );

  expect(result.isError).toBeUndefined();
  const content = String(result.content);
  // Both grep-specific caps fired (byte cap at 200 bytes, line cap at 3
  // matches) but neither attaches its own notice — ripgrep-plugin.ts leaves
  // that to result-truncation-plugin.ts, which runs later in the real chain
  // and sees the final content. A regression that reintroduces either cap's
  // own notice text would fail this.
  expect(content.split("\n").length).toBeLessThanOrEqual(3);
  expect(content).not.toMatch(/showing first|exceeded \d+ bytes|timed out/);
});

// The same result, run through the full chain (ripgrepPlugin then
// result-truncation-plugin, matching buildCorePosixToolPlugins in
// src/agent/posix-tool-plugins.ts), still carries at most one notice — the
// grep-specific caps stay silent and result-truncation-plugin.ts's char cap
// is the backstop for content that's still oversized after them.
test("a large grep result carries at most one truncation notice through the plugin chain", async () => {
  await withTempDir(async (dir) => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i} ${"x".repeat(300)}`);
    await writeFile(join(dir, "big.txt"), lines.join("\n") + "\n");

    const grepHandler = ripgrepPlugin(dir).middleware!(fallback);
    const handler = resultTruncationPlugin().middleware!(grepHandler);
    const result = await handler(
      { id: "c", name: "grep", arguments: { pattern: "line", path: dir } },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const content = String(result.content);
    expect(content).toContain("output truncated");
    expect(content).not.toContain("showing first");
    expect((content.match(/\[output truncated/g) ?? []).length).toBe(1);
  });
});

test("grep returns partial matches when the timeout fires", async () => {
  const result = await run(
    { id: "c", name: "grep", arguments: { pattern: "e", path: "src" } },
    { timeoutMs: 1 },
    stalledSpawn,
  );
  expect(result.isError).toBeUndefined();
  expect(result.content).toContain("timed out");
  expect(result.content).toContain("narrow path/glob");
});
