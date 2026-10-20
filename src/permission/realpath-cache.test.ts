import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

import {
  UNRESOLVABLE,
  realpathFollowingDangling,
  realpathNearestOr,
} from "./path-restriction.js";
import { resolvePerCallShellCwd } from "../shell/persistent-shell-cwd.js";
import { withMockedModuleDuring } from "../../testkit/mock-module.js";

let scratch = "";

afterEach(async () => {
  if (scratch.length > 0) {
    await rm(scratch, { recursive: true, force: true });
    scratch = "";
  }
});

test("an existing path uses realpath spelling, including case", async () => {
  scratch = await mkdtemp(join(tmpdir(), "corbits-realpath-case-"));
  const dir = join(scratch, "CaseDir");
  await mkdir(dir);
  await writeFile(join(dir, ".env"), "x");
  await writeFile(join(dir, "secret.pem"), "x");
  const envVariant = join(scratch, "casedir", ".ENV");
  const pemVariant = join(scratch, "casedir", "secret.PEM");
  let canonicalEnv: string;
  let canonicalPem: string;
  try {
    canonicalEnv = realpathSync(envVariant);
    canonicalPem = realpathSync(pemVariant);
  } catch {
    // Case-sensitive volumes cannot spell the same inode two ways.
    return;
  }
  expect(canonicalEnv.endsWith(`${sep}.env`)).toBe(true);
  expect(canonicalPem.endsWith(`${sep}secret.pem`)).toBe(true);
  expect(realpathNearestOr(envVariant)).toBe(canonicalEnv);
  expect(realpathNearestOr(pemVariant)).toBe(canonicalPem);
});

test("a relative single-segment path is not sliced when its dirname is dot", () => {
  const missing = "secret.pem";
  const resolved = realpathNearestOr(missing);
  expect(resolved).toBe(join(realpathSync("."), missing));
  expect(resolved.endsWith(`${sep}cret.pem`)).toBe(false);
});

test("dotdot through a symlink to a file matches realpathSync", async () => {
  scratch = await mkdtemp(join(tmpdir(), "corbits-realpath-dotdot-"));
  const sub = join(scratch, "sub");
  await mkdir(sub);
  await writeFile(join(scratch, "outside-target"), "t");
  await writeFile(join(sub, "file"), "f");
  await symlink(join(scratch, "outside-target"), join(sub, "link"));
  const through = `${join(sub, "link")}${sep}..${sep}file`;
  const canonical = realpathSync(through);
  expect(canonical).toBe(realpathSync(join(sub, "file")));
  expect(realpathNearestOr(through)).toBe(canonical);
  expect(realpathNearestOr(through)).not.toBe(
    join(realpathSync(scratch), "file"),
  );
});

test("a failed dot lstat is not reused for the symlink it collapses onto", async () => {
  scratch = await mkdtemp(join(tmpdir(), "corbits-realpath-dot-"));
  const sub = join(scratch, "sub");
  await mkdir(sub);
  const outside = join(scratch, "outside-target");
  await writeFile(outside, "t");
  await symlink(outside, join(sub, "link"));
  const previous = process.cwd();
  process.chdir(scratch);
  try {
    expect(realpathNearestOr("sub/link/.")).toBe(realpathSync("sub/link/."));
    expect(realpathNearestOr("sub/link/./missing")).toBe(
      join(realpathSync(outside), "missing"),
    );
  } finally {
    process.chdir(previous);
  }
});

test("a dot segment does not reuse the dangling symlink lstat", async () => {
  scratch = await mkdtemp(join(tmpdir(), "corbits-realpath-dang-dot-"));
  const sub = join(scratch, "sub");
  await mkdir(sub);
  await symlink("missing-target", join(sub, "dang"));
  const previous = process.cwd();
  process.chdir(scratch);
  try {
    const target = join(process.cwd(), "sub", "missing-target");
    expect(realpathFollowingDangling("sub/dang/.")).toBe(target);
    expect(realpathFollowingDangling("sub/dang/./missing")).toBe(
      join(target, "missing"),
    );
  } finally {
    process.chdir(previous);
  }
});

test("a later check of the same path lstats and realpaths again", async () => {
  scratch = await mkdtemp(join(tmpdir(), "corbits-realpath-once-"));
  const ancestorA = join(scratch, "a");
  const ancestorB = join(ancestorA, "b");
  const file = join(ancestorB, "c.txt");
  await mkdir(ancestorB, { recursive: true });
  await writeFile(file, "x");
  const canonical = realpathSync(file);

  const lstatCounts = new Map<string, number>();
  let realpathCalls = 0;

  await withMockedModuleDuring(
    "node:fs",
    (realFS: typeof import("node:fs")) => ({
      ...realFS,
      lstatSync: (path: Parameters<typeof realFS.lstatSync>[0]) => {
        const key = String(path);
        lstatCounts.set(key, (lstatCounts.get(key) ?? 0) + 1);
        return realFS.lstatSync(path);
      },
      realpathSync: (path: Parameters<typeof realFS.realpathSync>[0]) => {
        realpathCalls++;
        return realFS.realpathSync(path);
      },
    }),
    async () => {
      expect(realpathNearestOr(file)).toBe(canonical);
      const lstatAfterFirst = new Map(lstatCounts);
      const realpathAfterFirst = realpathCalls;
      expect(realpathAfterFirst).toBeGreaterThan(0);
      expect(lstatAfterFirst.get(file)).toBe(1);
      expect(realpathNearestOr(file)).toBe(canonical);
      expect(realpathCalls).toBeGreaterThan(realpathAfterFirst);
      expect(lstatCounts.get(file)).toBe(2);
    },
  );
});

test("lstat of one path is reused inside a single check and not after it", async () => {
  scratch = await mkdtemp(join(tmpdir(), "corbits-realpath-memo-"));
  const link = join(scratch, "link");
  await symlink("missing-target", link);
  const lstatCounts = new Map<string, number>();

  await withMockedModuleDuring(
    "node:fs",
    (realFS: typeof import("node:fs")) => ({
      ...realFS,
      lstatSync: (path: Parameters<typeof realFS.lstatSync>[0]) => {
        const key = String(path);
        lstatCounts.set(key, (lstatCounts.get(key) ?? 0) + 1);
        return realFS.lstatSync(path);
      },
    }),
    async () => {
      expect(realpathFollowingDangling(link)).toBe(
        join(realpathSync(scratch), "missing-target"),
      );
      expect(lstatCounts.get(link)).toBe(1);
      expect(realpathNearestOr(link)).toBe(UNRESOLVABLE);
      expect(lstatCounts.get(link)).toBe(2);
    },
  );
});

test("a path replaced by a dangling symlink is not served from the old real path", async () => {
  scratch = await mkdtemp(join(tmpdir(), "corbits-realpath-dangle-"));
  const file = join(scratch, "a", "b", "c.txt");
  await mkdir(join(scratch, "a", "b"), { recursive: true });
  await writeFile(file, "x");

  expect(realpathNearestOr(file)).toBe(realpathSync(file));

  await rm(file);
  await symlink("missing-target", file);

  expect(realpathNearestOr(file)).toBe(UNRESOLVABLE);
});

test("a symlink whose target disappears is reported dangling", async () => {
  scratch = await mkdtemp(join(tmpdir(), "corbits-realpath-target-"));
  const target = join(scratch, "target");
  const link = join(scratch, "link");
  await mkdir(target);
  await symlink(target, link);

  expect(realpathNearestOr(link)).toBe(realpathSync(target));

  await rm(target, { recursive: true });

  expect(realpathNearestOr(link)).toBe(UNRESOLVABLE);
});

test("a symlink that appears at a missing path is not hidden by the earlier join", async () => {
  scratch = await mkdtemp(join(tmpdir(), "corbits-realpath-appear-"));
  const parent = join(scratch, "a");
  const missing = join(parent, "missing");
  await mkdir(parent);

  expect(realpathNearestOr(missing)).toBe(
    join(realpathSync(parent), "missing"),
  );

  await symlink("nowhere", missing);

  expect(realpathNearestOr(missing)).toBe(UNRESOLVABLE);
});

test("an existing file reached through a retargeted symlink resolves to the new target", async () => {
  scratch = await mkdtemp(join(tmpdir(), "corbits-realpath-retarget-"));
  const inside = join(scratch, "inside");
  const outside = join(scratch, "outside");
  await mkdir(inside);
  await mkdir(outside);
  const name = "world.txt";
  await writeFile(join(inside, name), "in");
  await writeFile(join(outside, name), "out");
  const link = join(scratch, "link");
  await symlink(inside, link);
  const through = join(link, name);

  expect(realpathNearestOr(through)).toBe(realpathSync(join(inside, name)));

  await rm(link);
  await symlink(outside, link);

  expect(realpathNearestOr(through)).toBe(realpathSync(join(outside, name)));
});

test("renaming an ancestor and replacing it with a symlink does not keep the old real path", async () => {
  // Rename preserves the leaf inode and a relative symlink's text. A leaf-only
  // cache key then returns the pre-rename jail path while realpath follows the
  // new ancestor symlink out of the jail.
  scratch = await mkdtemp(join(tmpdir(), "corbits-realpath-rename-"));
  const jail = join(scratch, "jail");
  const outside = join(scratch, "outside");
  const sub = join(jail, "sub");
  const dir = join(sub, "dir");
  const file = join(dir, "file.txt");
  await mkdir(dir, { recursive: true });
  await mkdir(outside);
  await writeFile(file, "x");
  const link = join(sub, "link");
  await symlink(join("dir", "file.txt"), link);

  const jailFile = realpathSync(file);
  const jailDir = realpathSync(dir);
  expect(realpathNearestOr(file)).toBe(jailFile);
  expect(realpathNearestOr(link)).toBe(jailFile);
  expect(resolvePerCallShellCwd(jail, join("sub", "dir"))).toBe(jailDir);

  const moved = join(outside, "sub");
  await rename(sub, moved);
  await symlink(moved, sub);

  const outsideFile = realpathSync(file);
  const outsideDir = realpathSync(join(moved, "dir"));
  expect(outsideFile).not.toBe(jailFile);
  expect(realpathNearestOr(file)).toBe(outsideFile);
  expect(realpathNearestOr(link)).toBe(outsideFile);
  expect(realpathNearestOr(file)).not.toBe(jailFile);
  expect(realpathNearestOr(link)).not.toBe(jailFile);
  expect(() => resolvePerCallShellCwd(jail, join("sub", "dir"))).toThrow(
    /outside the session workspace/,
  );
  expect(
    resolvePerCallShellCwd(jail, join("sub", "dir"), {
      allowOutsideSession: true,
    }),
  ).toBe(outsideDir);
});

test("a symlink target tree moved out from behind an unchanged link is not served as the old real path", async () => {
  // jail/link → inner/sub. Lexical stamps of the link do not include jail/inner.
  // Moving that directory and symlinking it back keeps the link text and the
  // leaf inode, so a cached link real path must not be reused or joined onto
  // a child that was never resolved.
  scratch = await mkdtemp(join(tmpdir(), "corbits-realpath-behind-"));
  const jail = join(scratch, "jail");
  const outside = join(scratch, "outside");
  const inner = join(jail, "inner");
  const sub = join(inner, "sub");
  const file = join(sub, "file.txt");
  await mkdir(sub, { recursive: true });
  await mkdir(outside);
  await writeFile(file, "x");
  const link = join(jail, "link");
  await symlink(join("inner", "sub"), link);

  expect(realpathNearestOr(link)).toBe(realpathSync(sub));

  const moved = join(outside, "inner");
  await rename(inner, moved);
  await symlink(moved, inner);

  const outsideSub = realpathSync(link);
  const outsideFile = realpathSync(join(link, "file.txt"));
  expect(outsideSub).toBe(realpathSync(join(moved, "sub")));
  expect(realpathNearestOr(link)).toBe(outsideSub);
  expect(realpathNearestOr(join(link, "file.txt"))).toBe(outsideFile);
  expect(() => resolvePerCallShellCwd(jail, "link")).toThrow(
    /outside the session workspace/,
  );
  expect(
    resolvePerCallShellCwd(jail, "link", { allowOutsideSession: true }),
  ).toBe(outsideSub);
});
