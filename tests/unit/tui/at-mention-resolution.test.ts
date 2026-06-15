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
  test("inlines small workspace-relative files", async () => {
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

  test("does not inline absolute paths", async () => {
    const dir = await fixture();
    try {
      const resolved = await resolveAtMentions(`read @${join(dir, "src", "small.ts")}`, dir);
      expect(resolved).toContain("(blocked: use a workspace-relative path)");
      expect(resolved).not.toContain("export const value = 1;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not follow symlinks outside the workspace", async () => {
    const dir = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "at-mention-resolution-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "outside secret\n");
      await symlink(outside, join(dir, "escape"));

      const resolved = await resolveAtMentions("read @escape/secret.txt", dir);
      expect(resolved).toContain("(blocked: outside workspace)");
      expect(resolved).not.toContain("outside secret");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
