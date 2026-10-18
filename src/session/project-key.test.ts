import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  projectKeyFor,
  projectRootFor,
  projectSessionsRoot,
  projectsRoot,
} from "./project-key.js";
import { initTemporaryGitRepo } from "../../testkit/temporary-git-repo.js";

let root = "";

beforeEach(async () => {
  root = join(
    tmpdir(),
    `corbits-project-key-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function commitReadme(dir: string): Promise<void> {
  await writeFile(join(dir, "README"), "x");
  execFileSync("git", ["add", "README"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

test("projectKeyFor is stable across calls for the same path", () => {
  const a = projectKeyFor(root);
  const b = projectKeyFor(root);
  expect(a).toBe(b);
  expect(a).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{8}$/);
});

test("projectKeyFor shares nested dirs under the same git toplevel", async () => {
  initTemporaryGitRepo(root);
  await commitReadme(root);

  const nested = join(root, "nested", "deep");
  await mkdir(nested, { recursive: true });
  expect(projectRootFor(nested)).toBe(projectRootFor(root));
  expect(projectRootFor(root)).toBe(realpathSync(root));
  expect(projectKeyFor(nested)).toBe(projectKeyFor(root));
});

test("projectRootFor spawns git rev-parse once for the same cwd", async () => {
  initTemporaryGitRepo(root);
  await commitReadme(root);

  const countFile = join(root, "rev-parse-spawns");
  await writeFile(countFile, "0\n");
  const realGit = execFileSync("/usr/bin/which", ["git"], {
    encoding: "utf8",
  }).trim();
  const bin = join(root, "git-bin");
  await mkdir(bin);
  const wrapper = join(bin, "git");
  const resolved = realpathSync(root);
  await writeFile(
    wrapper,
    `#!/bin/sh
if [ "$1" = "rev-parse" ] && [ "$(pwd)" = ${shQuote(resolved)} ]; then
  n=$(cat ${shQuote(countFile)})
  echo $((n + 1)) > ${shQuote(countFile)}
fi
exec ${shQuote(realGit)} "$@"
`,
  );
  await chmod(wrapper, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  try {
    const first = projectRootFor(root);
    const second = projectRootFor(root);
    expect(second).toBe(first);
    expect(first).toBe(realpathSync(root));
    const spawns = Number((await readFile(countFile, "utf8")).trim());
    expect(spawns).toBe(1);
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
});

test("projectRootFor resolves a directory created after a missing lookup", async () => {
  initTemporaryGitRepo(root);
  await commitReadme(root);

  const parent = realpathSync(root);
  const child = join(parent, "child");
  expect(projectRootFor(child)).toBe(child);
  await mkdir(child);
  expect(projectRootFor(child)).toBe(parent);
});

test("projectRootFor retries a nested dir after git was unavailable", async () => {
  initTemporaryGitRepo(root);
  await commitReadme(root);

  const nested = join(root, "nested");
  await mkdir(nested);
  const parent = realpathSync(root);
  const emptyBin = join(root, "empty-bin");
  await mkdir(emptyBin);

  const previousPath = process.env.PATH;
  process.env.PATH = emptyBin;
  try {
    expect(projectRootFor(nested)).toBe(realpathSync(nested));
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
  expect(projectRootFor(nested)).toBe(parent);
});

test("linked worktrees have distinct project roots and keys from main and each other", async () => {
  initTemporaryGitRepo(root);
  await commitReadme(root);

  const wtA = join(
    root,
    "..",
    `wt-a-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const wtB = join(
    root,
    "..",
    `wt-b-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    execFileSync("git", ["worktree", "add", "--detach", wtA, "HEAD"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["worktree", "add", "--detach", wtB, "HEAD"], {
      cwd: root,
      stdio: "ignore",
    });

    expect(projectRootFor(wtA)).not.toBe(projectRootFor(root));
    expect(projectRootFor(wtB)).not.toBe(projectRootFor(root));
    expect(projectRootFor(wtA)).not.toBe(projectRootFor(wtB));
    expect(projectRootFor(wtA)).toBe(realpathSync(wtA));
    expect(projectRootFor(wtB)).toBe(realpathSync(wtB));
    expect(projectKeyFor(wtA)).not.toBe(projectKeyFor(root));
    expect(projectKeyFor(wtB)).not.toBe(projectKeyFor(root));
    expect(projectKeyFor(wtA)).not.toBe(projectKeyFor(wtB));
  } finally {
    for (const wt of [wtA, wtB]) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", wt], {
          cwd: root,
          stdio: "ignore",
        });
      } catch {
        await rm(wt, { recursive: true, force: true });
      }
    }
  }
});

test("projectSessionsRoot lives under ~/.corbits/projects/<key>", () => {
  const home = join(root, "home");
  const key = projectKeyFor(root);
  expect(projectsRoot(home)).toBe(join(home, ".corbits", "projects"));
  expect(projectSessionsRoot(root, home)).toBe(
    join(home, ".corbits", "projects", key),
  );
});
