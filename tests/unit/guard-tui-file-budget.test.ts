import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The budget ratchet's value is in its failure branches: a green run proves
// nothing about enforcement. Each test builds a fixture tree and pins both the
// exit code and the message shape the guard emits for that violation.

const repoRoot = join(import.meta.dirname, "../..");
const guardScript = join(repoRoot, "scripts/guard-tui-file-budget.ts");

interface GuardResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runGuard(cwd: string): Promise<GuardResult> {
  const proc = Bun.spawn(["bun", guardScript], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

interface Fixture {
  dir: string;
  write: (path: string, contents: string) => Promise<void>;
}

async function withFixture(
  budgets: Record<string, unknown>,
  files: Record<string, string>,
  run: (fixture: Fixture, result: GuardResult) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tui-budget-guard-"));
  try {
    const write = async (path: string, contents: string) => {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), contents);
    };
    await mkdir(join(dir, "scripts"), { recursive: true });
    await writeFile(join(dir, "scripts", "budgets.json"), JSON.stringify(budgets, null, 2) + "\n");
    for (const [path, contents] of Object.entries(files)) {
      await write(path, contents);
    }
    await run({ dir, write }, await runGuard(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("guard-tui-file-budget fail branches", () => {
  test("fails when a file exceeds its budget", async () => {
    await withFixture(
      { "src/tui/big.ts": 2 },
      { "src/tui/big.ts": "a\nb\nc\n" },
      async (_fixture, { exitCode, stderr }) => {
        expect(exitCode).toBe(1);
        expect(stderr).toContain("guard-tui-file-budget: 1 violation(s):");
        expect(stderr).toContain(
          "src/tui/big.ts: 4 lines exceeds budget of 2 — split the file instead of raising the budget",
        );
      },
    );
  });

  test("fails when a src/tui file is not listed in budgets.json", async () => {
    await withFixture(
      { "src/tui/known.ts": 10 },
      { "src/tui/known.ts": "ok\n", "src/tui/extra.ts": "surprise\n" },
      async (_fixture, { exitCode, stderr }) => {
        expect(exitCode).toBe(1);
        expect(stderr).toContain("guard-tui-file-budget: 1 violation(s):");
        expect(stderr).toContain(
          "src/tui/extra.ts: not listed in scripts/budgets.json (2 lines) — add it with an explicit budget",
        );
      },
    );
  });

  test("fails on a non-numeric budget value", async () => {
    await withFixture(
      { "src/tui/odd.ts": "lots" },
      { "src/tui/odd.ts": "ok\n" },
      async (_fixture, { exitCode, stderr }) => {
        expect(exitCode).toBe(1);
        expect(stderr).toContain(
          "guard-tui-file-budget: scripts/budgets.json is malformed (expected a record of path -> line count):",
        );
      },
    );
  });

  test("fails on a stale budget key whose file no longer exists", async () => {
    await withFixture(
      { "src/tui/renamed-away.ts": 10, "src/tui/current.ts": 10 },
      { "src/tui/current.ts": "ok\n" },
      async (_fixture, { exitCode, stderr }) => {
        expect(exitCode).toBe(1);
        expect(stderr).toContain("guard-tui-file-budget: 1 violation(s):");
        expect(stderr).toContain(
          "src/tui/renamed-away.ts: budget entry for a file that no longer exists — remove the stale key",
        );
      },
    );
  });

  test("scans dot-prefixed files so they cannot dodge the budget", async () => {
    await withFixture(
      { "src/tui/.hidden.ts": 2 },
      { "src/tui/.hidden.ts": "x\ny\nz\nw\n" },
      async (_fixture, { exitCode, stderr }) => {
        expect(exitCode).toBe(1);
        expect(stderr).toContain(
          "src/tui/.hidden.ts: 5 lines exceeds budget of 2 — split the file instead of raising the budget",
        );
      },
    );
  });

  test("passes on a clean tree with every file within budget", async () => {
    await withFixture(
      { "src/tui/fine.ts": 5 },
      { "src/tui/fine.ts": "ok\n" },
      async (_fixture, { exitCode, stdout }) => {
        expect(exitCode).toBe(0);
        expect(stdout).toContain("guard-tui-file-budget: all src/tui files within budget");
      },
    );
  });
});
