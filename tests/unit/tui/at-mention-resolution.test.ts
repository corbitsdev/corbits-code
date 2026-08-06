import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveAtMentions } from "../../../src/tui/mention-resolution.js";
import { mintPathGrant } from "../../../src/permission/path-grants.js";

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
      const { text, grants } = await resolveAtMentions("read @src/small.ts", dir);
      expect(text).toContain("`src/small.ts`:");
      expect(text).toContain("export const value = 1;");
      expect(grants).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not inline sensitive files", async () => {
    const dir = await fixture();
    try {
      const { text, grants } = await resolveAtMentions("read @.env", dir);
      expect(text).toContain("@.env (blocked: sensitive path)");
      expect(text).not.toContain("API_KEY=secret");
      expect(grants).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not inline oversized files", async () => {
    const dir = await fixture();
    try {
      const { text, grants } = await resolveAtMentions("read @large.txt", dir);
      expect(text).toContain("@large.txt (blocked: file is too large");
      expect(text.length).toBeLessThan(500);
      expect(grants).toEqual([]);
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

      const { text, grants } = await resolveAtMentions("read @one.txt @two.txt @three.txt", dir);
      expect(text).toContain("`one.txt`:");
      expect(text).toContain("`two.txt`:");
      expect(text).toContain("@three.txt (blocked: total @mention content is too large");
      expect(text.length).toBeLessThan(400_500);
      expect(grants).toEqual([]);
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

      const { text } = await resolveAtMentions(
        "read @small-0.txt @small-1.txt @small-2.txt @small-3.txt @small-4.txt @small-5.txt",
        dir,
      );
      expect(text).toContain("`small-4.txt`:");
      expect(text).toContain("@small-5.txt (blocked: too many @mentions");
      expect(text).not.toContain("file 5");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("inlines absolute paths", async () => {
    const dir = await fixture();
    try {
      const absolutePath = join(dir, "src", "small.ts");
      const { text, grants } = await resolveAtMentions(`read @${absolutePath}`, dir);
      expect(text).toContain(`\`${absolutePath}\`:`);
      expect(text).toContain("export const value = 1;");
      expect(grants).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("inlines parent-directory paths", async () => {
    const dir = await fixture();
    try {
      const { text, grants } = await resolveAtMentions("read @../src/small.ts", join(dir, "src"));
      expect(text).toContain("`../src/small.ts`:");
      expect(text).toContain("export const value = 1;");
      expect(grants).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("expands symlinked outside-workspace files and mints a read grant", async () => {
    const dir = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "at-mention-resolution-outside-"));
    try {
      await writeFile(join(outside, "outside.txt"), "outside content\n");
      await symlink(outside, join(dir, "escape"));

      const { text, grants } = await resolveAtMentions("read @escape/outside.txt", dir);
      expect(text).toContain("outside content");
      expect(grants.length).toBe(1);
      expect(grants[0]?.kind).toBe("file");
      expect(grants[0]?.mode).toBe("read");
      expect(grants[0]?.path).toBe(realpathSync(join(outside, "outside.txt")));
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("expands absolute outside-workspace paths and mints a read grant", async () => {
    const dir = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "at-mention-resolution-outside-"));
    try {
      const outsideFile = join(outside, "outside.txt");
      await writeFile(outsideFile, "outside content\n");

      const { text, grants } = await resolveAtMentions(`read @${outsideFile}`, dir);
      expect(text).toContain("outside content");
      expect(grants.length).toBe(1);
      expect(grants[0]).toEqual({
        path: realpathSync(outsideFile),
        mode: "read",
        kind: "file",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("expands parent-traversal outside-workspace paths and mints a read grant", async () => {
    const dir = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "at-mention-resolution-outside-"));
    try {
      await writeFile(join(outside, "outside.txt"), "outside content\n");
      const traversal = `../../${outside.split("/").pop() ?? ""}/outside.txt`;

      const { text, grants } = await resolveAtMentions(`read @${traversal}`, join(dir, "src"));
      expect(text).toContain("outside content");
      expect(grants.length).toBe(1);
      expect(grants[0]?.kind).toBe("file");
      expect(grants[0]?.path).toBe(realpathSync(join(outside, "outside.txt")));
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("does not re-mint grants for paths covered by existingGrants", async () => {
    const dir = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "at-mention-resolution-outside-"));
    try {
      const outsideFile = join(outside, "outside.txt");
      await writeFile(outsideFile, "outside content\n");

      const { text, grants } = await resolveAtMentions(`read @${outsideFile}`, dir, {
        existingGrants: [mintPathGrant(outsideFile, "file")],
      });
      expect(text).toContain("outside content");
      expect(grants).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("mints a dir grant for outside-workspace directories", async () => {
    const dir = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "at-mention-resolution-outside-"));
    try {
      await writeFile(join(outside, "a.txt"), "a\n");
      await mkdir(join(outside, "sub"));

      const { text, grants } = await resolveAtMentions(`read @${outside}`, dir);
      expect(text).toContain("directory - ");
      expect(grants.length).toBe(1);
      expect(grants[0]?.kind).toBe("dir");
      expect(grants[0]?.path).toBe(realpathSync(outside));
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

      const { text, grants } = await resolveAtMentions(`read @${outsideEnv}`, dir);
      expect(text).toContain("(blocked: sensitive path)");
      expect(text).not.toContain("API_KEY=secret");
      expect(grants).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("does not grant when total content limit blocks the read", async () => {
    const dir = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "at-mention-resolution-outside-"));
    try {
      await writeFile(join(dir, "one.txt"), "a".repeat(180_000));
      await writeFile(join(dir, "two.txt"), "b".repeat(180_000));
      const outsideFile = join(outside, "big.txt");
      await writeFile(outsideFile, "c".repeat(180_000));

      const { grants } = await resolveAtMentions(`read @one.txt @two.txt @${outsideFile}`, dir);
      // First two inlined in-workspace (no grant); third blocked by total cap
      // before any grant is minted (mint happens just before readFile).
      expect(grants).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("inlines mentions into a sibling git worktree of the same session", async () => {
    const repo = await mkdtemp(join(tmpdir(), "at-mention-resolution-repo-"));
    const worktree = await mkdtemp(join(tmpdir(), "at-mention-resolution-worktree-"));
    await rm(worktree, { recursive: true, force: true });
    try {
      await execFileAsync("git", ["init"], { cwd: repo });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repo });
      await writeFile(join(repo, "README.md"), "root\n");
      await execFileAsync("git", ["add", "README.md"], { cwd: repo });
      await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
      await execFileAsync("git", ["worktree", "add", "-b", "sibling", worktree], { cwd: repo });
      await writeFile(join(worktree, "shared.ts"), "export const shared = true;\n");

      const { text, grants } = await resolveAtMentions(`read @${join(worktree, "shared.ts")}`, repo);
      expect(text).toContain(`\`${join(worktree, "shared.ts")}\`:`);
      expect(text).toContain("export const shared = true;");
      expect(grants).toEqual([]);
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

      const { text, grants } = await resolveAtMentions("read @looks-safe.txt", dir);
      expect(text).toContain("@looks-safe.txt (blocked: sensitive path)");
      expect(text).not.toContain("API_KEY=secret");
      expect(grants).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
