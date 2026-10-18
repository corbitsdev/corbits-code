import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { UNRESOLVABLE, realpathNearestOr } from "./path-restriction.js";
import { withMockedModuleDuring } from "../../testkit/mock-module.js";

let scratch = "";

afterEach(async () => {
  if (scratch.length > 0) {
    await rm(scratch, { recursive: true, force: true });
    scratch = "";
  }
});

test("two checks of the same existing path lstat ancestors once", async () => {
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
        expect(lstatCounts.get(ancestor)).toBe(1);
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
