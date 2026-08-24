import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";

// Runs `bun test` and fails the run if any test wrote into the real
// ~/.corbits/projects directory. Tests must sandbox state under a temp
// `home` (see src/session/index.ts's `home` overrides); nothing running
// under this wrapper is allowed to fall back to the developer's own
// session history.
//
// This is a backstop, not a substitute for threading `home` correctly: a
// leak is only caught after it already wrote into a real directory once,
// which this script then reports and leaves in place for inspection.
//
// Attribution: a plain before/after snapshot of the whole directory also
// picks up entries from other checkouts on this machine running their own
// `bun run check` concurrently — a routine part of working across several
// worktrees, and not something this run's suite is responsible for. To tell
// the two apart, this run's own temp dirs are pointed at a unique,
// per-invocation scratch directory (via TMPDIR) whose name carries this
// run's id. `src/session/project-key.ts` derives a project key from the
// realpath of the test's `cwd`/`home`, and since those are mkdtemp'd inside
// our scratch dir here, a real leak's project key inherits our run id as a
// substring. Only entries that carry it are ours to fail on; anything else
// is a sibling checkout's own business.

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

  const args = process.argv.slice(2);
  const child = spawn("bun", ["test", ...args], {
    stdio: "inherit",
    env: { ...process.env, TMPDIR: runTmpDir, TMP: runTmpDir, TEMP: runTmpDir },
  });
  const testExitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
  });

  await rm(runTmpDir, { recursive: true, force: true }).catch(() => {});

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
        "tests/unit/workflow-controller.test.ts for the pattern.\n",
    );
    process.exit(1);
  }

  process.exit(testExitCode);
}

void main();
