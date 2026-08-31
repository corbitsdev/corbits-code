import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface InitTemporaryGitRepoOpts {
  /** Extra arguments after `git init` (`-b main`, `--bare`, `-q`). */
  initArgs?: readonly string[];
}

/**
 * Initialize a throwaway Git repository for tests.
 *
 * Sets a local identity and points `core.hooksPath` at an empty directory
 * inside the repo so machine-level hooks cannot reject fixture commits.
 * Never writes global or system Git configuration and does not use
 * `GIT_CONFIG_*` env workarounds.
 */
export function initTemporaryGitRepo(dir: string, opts: InitTemporaryGitRepoOpts = {}): void {
  git(dir, "init", ...(opts.initArgs ?? []));
  const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
  const hooksDir = join(gitDir, "corbits-no-hooks");
  mkdirSync(hooksDir, { recursive: true });
  git(dir, "config", "--local", "core.hooksPath", hooksDir);
  git(dir, "config", "--local", "user.email", "t@t.test");
  git(dir, "config", "--local", "user.name", "t");
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
