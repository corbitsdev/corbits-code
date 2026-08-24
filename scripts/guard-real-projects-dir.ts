import { homedir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
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

  const args = process.argv.slice(2);
  const child = spawn("bun", ["test", ...args], { stdio: "inherit" });
  const testExitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
  });

  const after = await listEntries();
  const leaked = [...after].filter((name) => !before.has(name));

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
