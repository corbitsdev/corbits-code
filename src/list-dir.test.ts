import { test, expect, describe } from "bun:test";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { listDirectory } from "./util/list-dir.js";

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "list-dir-"));
  await writeFile(join(dir, "b.ts"), "");
  await writeFile(join(dir, "a.ts"), "");
  await mkdir(join(dir, "sub"));
  return dir;
}

/**
 * Parameterized outside-workspace setup: a fresh tmp dir containing `file`.
 * With `linkName`, the outside dir is also symlinked to
 * `join(dir, linkName)` (the symlink-escape shape).
 */
async function outsideFixture(
  dir: string,
  options: { file: string; prefix?: string; linkName?: string },
): Promise<string> {
  const outside = await mkdtemp(
    join(tmpdir(), options.prefix ?? "list-dir-outside-"),
  );
  await writeFile(join(outside, options.file), "");
  if (options.linkName !== undefined) {
    await symlink(outside, join(dir, options.linkName));
  }
  return outside;
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
    await outsideFixture(dir, { file: "secret.txt", linkName: "escape" });
    const out = await listDirectory(dir, "escape");
    expect(out).toContain("outside the workspace");
    expect(out).not.toContain("secret.txt");
  });

  test("allowOutside lists a path outside the workspace", async () => {
    const dir = await fixture();
    const outside = await outsideFixture(dir, {
      file: "other.txt",
      prefix: "list-dir-yolo-",
    });
    const out = await listDirectory(dir, outside, { allowOutside: true });
    expect(out.split("\n")).toContain("other.txt");
    expect(out).not.toContain("outside the workspace");
  });

  test("allowOutside follows a symlink that resolves outside the workspace", async () => {
    const dir = await fixture();
    await outsideFixture(dir, {
      file: "secret.txt",
      prefix: "list-dir-yolo-link-",
      linkName: "escape",
    });
    const out = await listDirectory(dir, "escape", { allowOutside: true });
    expect(out.split("\n")).toContain("secret.txt");
  });

  test("allowOutside getter is resolved per call", async () => {
    const dir = await fixture();
    const outside = await outsideFixture(dir, {
      file: "other.txt",
      prefix: "list-dir-yolo-getter-",
    });
    let allow = false;
    const blocked = await listDirectory(dir, outside, {
      allowOutside: () => allow,
    });
    expect(blocked).toContain("outside the workspace");

    allow = true;
    const out = await listDirectory(dir, outside, {
      allowOutside: () => allow,
    });
    expect(out.split("\n")).toContain("other.txt");
    expect(out).not.toContain("outside the workspace");
  });

  test("lists a registered sibling worktree root (CL-6729)", async () => {
    const dir = await fixture();
    const sibling = await outsideFixture(dir, {
      file: "sibling-file.txt",
      prefix: "list-dir-sibling-",
    });
    const roots = [await realpath(sibling)];

    const out = await listDirectory(dir, sibling, {
      rootsProvider: () => roots,
    });
    expect(out.split("\n")).toContain("sibling-file.txt");
    expect(out).not.toContain("outside the workspace");
  });

  test("lists a sibling worktree via relative traversal (CL-6729)", async () => {
    const dir = await fixture();
    const sibling = await outsideFixture(dir, {
      file: "sibling-file.txt",
      prefix: "list-dir-sibling-rel-",
    });
    const roots = [await realpath(sibling)];

    const out = await listDirectory(dir, join("..", basename(sibling)), {
      rootsProvider: () => roots,
    });
    expect(out.split("\n")).toContain("sibling-file.txt");
    expect(out).not.toContain("outside the workspace");
  });

  test("lists through an aliased session root (CL-6729)", async () => {
    const dir = await fixture();
    const realDir = await realpath(dir);
    const alias = `${realDir}-alias`;
    await symlink(realDir, alias);

    const out = await listDirectory(alias, realDir);
    expect(out.split("\n")).toEqual(["a.ts", "b.ts", "sub/"]);
  });
});
