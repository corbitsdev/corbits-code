import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";

// Runs the test suite and fails the run if any test wrote into the real
// ~/.corbits/projects directory. Tests must sandbox state under a temp
// `home` (see src/session/index.ts's `home` overrides); nothing running
// under this wrapper may fall back to the developer's own session history.
//
// A backstop, not a substitute for threading `home` correctly: a leak is
// caught only after it already wrote into a real directory once, which this
// script then reports and leaves in place for inspection.
//
// Attribution: a plain before/after snapshot also picks up entries from other
// checkouts running their own `bun run check` concurrently. To tell them
// apart, this run's temp dirs sit in a unique per-invocation scratch dir (via
// TMPDIR) whose name carries this run's id. `src/session/project-key.ts`
// derives a project key from the realpath of the test's `cwd`/`home`, and
// since those are mkdtemp'd inside our scratch dir, a real leak's key
// inherits our run id as a substring. Only entries that carry it are ours to
// fail on.

const projectsDir = join(homedir(), ".corbits", "projects");

async function listEntries(): Promise<Set<string>> {
  try {
    return new Set(await readdir(projectsDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw err;
  }
}

async function main(): Promise<void> {
  const before = await listEntries();

  const runId = randomUUID();
  const runTmpDir = join(tmpdir(), `corbits-test-guard-${runId}`);
  await mkdir(runTmpDir, { recursive: true });

  // CI shards pass bun-test path filters (e.g. ./src). Filters are additive,
  // so appending them to `bun run test` would widen the run back to the full
  // suite; a sharded run goes through test:paths, which carries the same
  // seeded flags and takes the shard's filters. No arguments keeps `bun run
  // test`, so `bun run check` behavior is unchanged.
  const shardArgs = process.argv.slice(2);
  const testCommand =
    shardArgs.length > 0
      ? ["run", "test:paths", ...shardArgs]
      : ["run", "test"];

  const child = spawn("bun", testCommand, {
    stdio: "inherit",
    env: { ...process.env, TMPDIR: runTmpDir, TMP: runTmpDir, TEMP: runTmpDir },
  });
  const testExitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
  });

  await rm(runTmpDir, { recursive: true, force: true }).catch(() => undefined);

  const after = await listEntries();
  const newEntries = [...after].filter((name) => !before.has(name));
  const leaked = newEntries.filter((name) => name.includes(runId));
  const unattributed = newEntries.filter((name) => !name.includes(runId));

  if (unattributed.length > 0) {
    process.stderr.write(
      `\nguard-real-projects-dir: ignoring ${unattributed.length} new ${projectsDir} ` +
        "entries not created by this run (likely another checkout's concurrent " +
        `test/check run):\n${unattributed.map((name) => `  ${name}`).join("\n")}\n`,
    );
  }

  if (leaked.length > 0) {
    process.stderr.write(
      `\nguard-real-projects-dir: ${leaked.length} test run wrote into the real ` +
        `${projectsDir} instead of a sandboxed temp dir:\n` +
        leaked.map((name) => `  ${name}`).join("\n") +
        "\n\nA test must pass an explicit `home` (mkdtemp'd) through to any " +
        "function that otherwise defaults to node:os homedir() — see " +
        "src/workflows/host.test.ts for the pattern.\n",
    );
    process.exit(1);
  }

  process.exit(testExitCode);
}

void main();
