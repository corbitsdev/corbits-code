import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { initTemporaryGitRepo } from "../helpers/temporary-git-repo.js";

const execFileAsync = promisify(execFile);
const script = join(import.meta.dir, "../../scripts/prepare-homebrew-tap-release.sh");

describe("prepare-homebrew-tap-release", () => {
  let root: string;
  let tapDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "corbits-release-tap-"));
    const origin = join(root, "origin.git");
    tapDir = join(root, "tap");
    await mkdir(origin);
    initTemporaryGitRepo(origin, { initArgs: ["--bare", "--initial-branch=main"] });
    await execFileAsync("git", ["clone", origin, tapDir]);
    initTemporaryGitRepo(tapDir);

    await mkdir(join(tapDir, "Formula"));
    await writeFile(join(tapDir, "Formula/corbits-code.rb"), "version one\n");
    await writeFile(join(tapDir, "formula_renames.json"), "{}\n");
    await execFileAsync("git", ["-C", tapDir, "add", "."]);
    await execFileAsync("git", ["-C", tapDir, "commit", "-m", "Initial tap"]);
    await execFileAsync("git", ["-C", tapDir, "push", "-u", "origin", "main"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("requests a push when generated files are unchanged but the tap is ahead", async () => {
    await writeFile(join(tapDir, "Formula/corbits-code.rb"), "version two\n");
    await execFileAsync("git", ["-C", tapDir, "add", "Formula/corbits-code.rb"]);
    await execFileAsync("git", ["-C", tapDir, "commit", "-m", "Pending formula"]);

    const result = await execFileAsync("bash", [script, tapDir, "1.2.3"]);

    expect(result.stdout.trim()).toBe("push-required");
  });
});
