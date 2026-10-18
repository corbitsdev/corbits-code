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
import { join } from "node:path";
import { tmpdir } from "node:os";

import { UNRESOLVABLE, realpathNearestOr } from "./path-restriction.js";
import { resolvePerCallShellCwd } from "../shell/persistent-shell-cwd.js";
import { withMockedModuleDuring } from "../../testkit/mock-module.js";

let scratch = "";

afterEach(async () => {
  if (scratch.length > 0) {
    await rm(scratch, { recursive: true, force: true });
    scratch = "";
  }
});

test("an unchanged path skips realpath but rechecks every ancestor", async () => {
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
      expect(realpathNearestOr(file)).toBe(canonical);
      expect(realpathCalls).toBe(realpathAfterFirst);
      for (const ancestor of [scratch, ancestorA, ancestorB]) {
        expect(lstatAfterFirst.get(ancestor)).toBe(1);
        expect(lstatCounts.get(ancestor)).toBe(2);
      }
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
