import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveAtMentions } from "../../../src/tui/mention-resolution.js";
import { initTemporaryGitRepo } from "../../helpers/temporary-git-repo.js";

const execFileAsync = promisify(execFile);

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "at-mention-resolution-"));
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "small.ts"), "export const value = 1;\n");
  await writeFile(join(dir, ".env"), "API_KEY=secret\n");
  await writeFile(join(dir, "large.txt"), "x".repeat(260_000));
  return dir;
}

describe("resolveAtMentions", () => {
  test("inlines small relative files", async () => {
    const dir = await fixture();
    try {
      const resolved = await resolveAtMentions("read @src/small.ts", dir);
      expect(resolved).toContain("`src/small.ts`:");
      expect(resolved).toContain("export const value = 1;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not inline sensitive files", async () => {
    const dir = await fixture();
    try {
      const resolved = await resolveAtMentions("read @.env", dir);
      expect(resolved).toContain("@.env (blocked: sensitive path)");
      expect(resolved).not.toContain("API_KEY=secret");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not inline oversized files", async () => {
    const dir = await fixture();
    try {
      const resolved = await resolveAtMentions("read @large.txt", dir);
      expect(resolved).toContain("@large.txt (blocked: file is too large");
      expect(resolved.length).toBeLessThan(500);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not exceed the cumulative mention content limit", async () => {
    const dir = await fixture();
    try {
      await writeFile(join(dir, "one.txt"), "a".repeat(180_000));
      await writeFile(join(dir, "two.txt"), "b".repeat(180_000));
      await writeFile(join(dir, "three.txt"), "c".repeat(180_000));

      const resolved = await resolveAtMentions("read @one.txt @two.txt @three.txt", dir);
      expect(resolved).toContain("`one.txt`:");
      expect(resolved).toContain("`two.txt`:");
      expect(resolved).toContain("@three.txt (blocked: total @mention content is too large");
      expect(resolved.length).toBeLessThan(400_500);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not resolve more than the maximum mention count", async () => {
    const dir = await fixture();
    try {
      for (let i = 0; i < 6; i++) {
        await writeFile(join(dir, `small-${i}.txt`), `file ${i}\n`);
      }

      const resolved = await resolveAtMentions(
        "read @small-0.txt @small-1.txt @small-2.txt @small-3.txt @small-4.txt @small-5.txt",
        dir,
      );
      expect(resolved).toContain("`small-4.txt`:");
      expect(resolved).toContain("@small-5.txt (blocked: too many @mentions");
      expect(resolved).not.toContain("file 5");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("inlines absolute paths", async () => {
    const dir = await fixture();
    try {
      const absolutePath = join(dir, "src", "small.ts");
      const resolved = await resolveAtMentions(`read @${absolutePath}`, dir);
      expect(resolved).toContain(`\`${absolutePath}\`:`);
      expect(resolved).toContain("export const value = 1;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("inlines parent-directory paths", async () => {
    const dir = await fixture();
    try {
      const resolved = await resolveAtMentions("read @../src/small.ts", join(dir, "src"));
      expect(resolved).toContain("`../src/small.ts`:");
      expect(resolved).toContain("export const value = 1;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("inlines symlinked outside-workspace files", async () => {
    const dir = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "at-mention-resolution-outside-"));
    try {
      await writeFile(join(outside, "outside.txt"), "outside content\n");
      await symlink(outside, join(dir, "escape"));

      const resolved = await resolveAtMentions("read @escape/outside.txt", dir);
      expect(resolved).toContain("outside content");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("inlines absolute outside-workspace paths", async () => {
    const dir = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "at-mention-resolution-outside-"));
    try {
      const outsideFile = join(outside, "outside.txt");
      await writeFile(outsideFile, "outside content\n");

      const resolved = await resolveAtMentions(`read @${outsideFile}`, dir);
      expect(resolved).toContain(`\`${outsideFile}\`:`);
      expect(resolved).toContain("outside content");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("inlines parent-traversal outside-workspace paths", async () => {
    const dir = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "at-mention-resolution-outside-"));
    try {
      await writeFile(join(outside, "outside.txt"), "outside content\n");
      const traversal = `../../${outside.split("/").pop() ?? ""}/outside.txt`;

      const resolved = await resolveAtMentions(`read @${traversal}`, join(dir, "src"));
      expect(resolved).toContain("outside content");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("summarizes outside-workspace directories", async () => {
    const dir = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "at-mention-resolution-outside-"));
    try {
      await writeFile(join(outside, "a.txt"), "a\n");
      await mkdir(join(outside, "sub"));

      const resolved = await resolveAtMentions(`read @${outside}`, dir);
      expect(resolved).toContain("directory - ");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("still blocks sensitive outside-workspace paths", async () => {
    const dir = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "at-mention-resolution-outside-"));
    try {
      const outsideEnv = join(outside, ".env");
      await writeFile(outsideEnv, "API_KEY=secret\n");

      const resolved = await resolveAtMentions(`read @${outsideEnv}`, dir);
      expect(resolved).toContain("(blocked: sensitive path)");
      expect(resolved).not.toContain("API_KEY=secret");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("blocks a symlink that points outside the workspace at a sensitive file", async () => {
    // Combines the two cases the other tests exercise separately: the symlink
    // test above targets a sensitive file *inside* the workspace, and the
    // outside-workspace sensitivity test above uses a direct path. Realpath
    // must resolve the symlink before the sensitivity check runs regardless
    // of which boundary (workspace, sensitivity) the target crosses.
    const dir = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "at-mention-resolution-outside-"));
    try {
      const outsideKey = join(outside, "id_rsa");
      await writeFile(outsideKey, "-----BEGIN OPENSSH PRIVATE KEY-----\n");
      await symlink(outsideKey, join(dir, "looks-like-a-normal-file"));

      const resolved = await resolveAtMentions("read @looks-like-a-normal-file", dir);
      expect(resolved).toContain("(blocked: sensitive path)");
      expect(resolved).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("blocks home-relative paths", async () => {
    const dir = await fixture();
    try {
      const resolved = await resolveAtMentions("read @~/some-file.txt", dir);
      expect(resolved).toContain("(blocked: home-relative paths are not supported)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("inlines mentions into a sibling git worktree of the same session", async () => {
    const repo = await mkdtemp(join(tmpdir(), "at-mention-resolution-repo-"));
    const worktree = await mkdtemp(join(tmpdir(), "at-mention-resolution-worktree-"));
    await rm(worktree, { recursive: true, force: true });
    try {
      initTemporaryGitRepo(repo);
      await writeFile(join(repo, "README.md"), "root\n");
      await execFileAsync("git", ["add", "README.md"], { cwd: repo });
      await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
      await execFileAsync("git", ["worktree", "add", "-b", "sibling", worktree], { cwd: repo });
      await writeFile(join(worktree, "shared.ts"), "export const shared = true;\n");

      const resolved = await resolveAtMentions(`read @${join(worktree, "shared.ts")}`, repo);
      expect(resolved).toContain(`\`${join(worktree, "shared.ts")}\`:`);
      expect(resolved).toContain("export const shared = true;");
    } finally {
      await execFileAsync("git", ["worktree", "remove", "--force", worktree]).catch(() => {});
      await rm(repo, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("does not inline sensitive files through workspace symlinks", async () => {
    const dir = await fixture();
    try {
      await symlink(join(dir, ".env"), join(dir, "looks-safe.txt"));

      const resolved = await resolveAtMentions("read @looks-safe.txt", dir);
      expect(resolved).toContain("@looks-safe.txt (blocked: sensitive path)");
      expect(resolved).not.toContain("API_KEY=secret");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
