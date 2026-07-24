import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAtMentions } from "../../../src/tui/app.js";

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

  test("blocks symlinks that resolve outside the workspace", async () => {
    const dir = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "at-mention-resolution-outside-"));
    try {
      await writeFile(join(outside, "outside.txt"), "outside content\n");
      await symlink(outside, join(dir, "escape"));

      const resolved = await resolveAtMentions("read @escape/outside.txt", dir);
      expect(resolved).toContain("@escape/outside.txt (blocked: outside workspace)");
      expect(resolved).not.toContain("outside content");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("blocks absolute paths outside the workspace", async () => {
    const dir = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "at-mention-resolution-outside-"));
    try {
      const outsideFile = join(outside, "outside.txt");
      await writeFile(outsideFile, "outside content\n");

      const resolved = await resolveAtMentions(`read @${outsideFile}`, dir);
      expect(resolved).toContain(`@${outsideFile} (blocked: outside workspace)`);
      expect(resolved).not.toContain("outside content");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("blocks parent-traversal paths that escape the workspace", async () => {
    const dir = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "at-mention-resolution-outside-"));
    try {
      await writeFile(join(outside, "outside.txt"), "outside content\n");
      const traversal = `../../${outside.split("/").pop() ?? ""}/outside.txt`;

      const resolved = await resolveAtMentions(`read @${traversal}`, join(dir, "src"));
      expect(resolved).toContain(`@${traversal} (blocked: outside workspace)`);
      expect(resolved).not.toContain("outside content");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
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
