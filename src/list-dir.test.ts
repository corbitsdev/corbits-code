import { test, expect, describe } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirectory } from "./util/list-dir.js";

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "list-dir-"));
  await writeFile(join(dir, "b.ts"), "");
  await writeFile(join(dir, "a.ts"), "");
  await mkdir(join(dir, "sub"));
  return dir;
}

describe("listDirectory", () => {
  test("lists entries sorted, marking directories with a trailing slash", async () => {
    const dir = await fixture();
    const out = await listDirectory(dir, ".");
    expect(out.split("\n")).toEqual(["a.ts", "b.ts", "sub/"]);
  });

  test("lists a subdirectory by relative path", async () => {
    const dir = await fixture();
    expect(await listDirectory(dir, "sub")).toBe("(empty directory) sub");
  });

  test("refuses to list outside the workspace", async () => {
    const dir = await fixture();
    const out = await listDirectory(dir, "../../../etc");
    expect(out).toContain("outside the workspace");
  });

  test("reports a readable error for a missing directory", async () => {
    const dir = await fixture();
    const out = await listDirectory(dir, "nope");
    expect(out).toContain("cannot list nope");
  });

  test("refuses to follow a symlink that resolves outside the workspace", async () => {
    const dir = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "list-dir-outside-"));
    await writeFile(join(outside, "secret.txt"), "");
    await symlink(outside, join(dir, "escape"));
    const out = await listDirectory(dir, "escape");
    expect(out).toContain("outside the workspace");
    expect(out).not.toContain("secret.txt");
  });
});
