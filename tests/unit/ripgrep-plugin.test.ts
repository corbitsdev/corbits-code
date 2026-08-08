import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { createPosixTools } from "@intx/tools-posix";

import { ripgrepPlugin } from "../../src/plugins/ripgrep-plugin.js";
import { MAX_RESULT_CHARS } from "../../src/plugins/result-truncation-plugin.js";
import { buildCorePosixToolPlugins } from "../../src/agent/posix-tool-plugins.js";
import { createPermissionGate } from "../../src/permission/gate.js";
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
// lines than max_results (ripgrep-plugin.ts's own count cap) used to stack the
// byte cap's wording on top of the count cap's. The byte cap is silent now, so
// what is left describes the omission the reader cannot otherwise detect: how
// many matches were dropped.
test("a grep result that hits both the byte cap and the match-count cap announces the dropped matches once", async () => {
  // 400 matched lines emitted directly, bypassing a real `rg` process so
  // nothing upstream of ripgrep-plugin.ts pre-limits the line count.
  const result = await run(
    { id: "c", name: "grep", arguments: { pattern: "match", path: cwd, max_results: 3 } },
    { maxOutputBytes: 200 },
    scriptedSpawn("big.txt:1:match line here\n".repeat(400), 0),
  );

  expect(result.isError).toBeUndefined();
  const content = String(result.content);
  expect(content.split("\n").filter((l) => l.includes("match line here")).length).toBe(3);
  expect((content.match(/showing first/g) ?? []).length).toBe(1);
  expect(content).not.toMatch(/exceeded \d+ bytes|timed out|\[output truncated/);
});

// Composed through buildCorePosixToolPlugins, not a hand-assembled pair:
// ripgrepPlugin sits at an earlier array index than resultTruncationPlugin and
// answers grep without calling next, so resultTruncationPlugin never sees a
// grep result. Assembling the two by hand in the other order hides that and
// lets an oversized result reach the model uncapped and unannounced.
async function grepThroughRealChain(dir: string): Promise<string> {
  const gate = createPermissionGate({
    approvals: [],
    interactive: false,
    skipPermissions: true,
    cwd: dir,
  });
  const runner = createPosixTools({
    cwd: dir,
    plugins: buildCorePosixToolPlugins({ cwd: dir, permissionGate: gate }),
  });
  const result = await runner.run(
    { id: "c", name: "grep", arguments: { pattern: "line", path: dir } },
    new AbortController().signal,
  );
  expect(result.isError).not.toBe(true);
  return String(result.content);
}

async function writeOversizedHaystack(dir: string): Promise<void> {
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(300)}`);
  await writeFile(join(dir, "big.txt"), lines.join("\n") + "\n");
}

function truncationNoticeCount(content: string): number {
  return (content.match(/\[output truncated/g) ?? []).length;
}

test("an oversized grep result is capped and announced once through the real plugin chain", async () => {
  await withTempDir(async (dir) => {
    await writeOversizedHaystack(dir);
    const content = await grepThroughRealChain(dir);

    expect(content.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 200);
    expect(truncationNoticeCount(content)).toBe(1);
    expect(content).not.toContain("showing first");
  });
});

test("an oversized grep result is capped and announced once when ripgrep is unavailable", async () => {
  await withTempDir(async (dir) => {
    await writeOversizedHaystack(dir);
    await withoutRipgrep(async () => {
      const content = await grepThroughRealChain(dir);

      expect(content.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 200);
      expect(truncationNoticeCount(content)).toBe(1);
      expect(content).not.toContain("showing first");
    });
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
