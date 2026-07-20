import { test, expect } from "bun:test";
import { createGuardedRefresh } from "./git-branch.js";

test("createGuardedRefresh reports the fetched branch", async () => {
  const seen: (string | null)[] = [];
  const refresh = createGuardedRefresh(
    "/repo",
    async (cwd) => {
      expect(cwd).toBe("/repo");
      return "main";
    },
    (branch) => seen.push(branch),
  );

  refresh();
  await Bun.sleep(0);
  expect(seen).toEqual(["main"]);
});

test("createGuardedRefresh skips refreshes while one is in flight", async () => {
  let calls = 0;
  let resolveFirst: (branch: string | null) => void = () => {};
  const refresh = createGuardedRefresh(
    "/repo",
    () => {
      calls += 1;
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    },
    () => {},
  );

  refresh();
  refresh();
  refresh();
  expect(calls).toBe(1);

  resolveFirst("main");
  await Bun.sleep(0);

  refresh();
  expect(calls).toBe(2);
});

test("createGuardedRefresh recovers when the fetch rejects", async () => {
  let calls = 0;
  const seen: (string | null)[] = [];
  const refresh = createGuardedRefresh(
    "/repo",
    () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("boom"));
      return Promise.resolve("main");
    },
    (branch) => seen.push(branch),
  );

  refresh();
  await Bun.sleep(0);
  expect(seen).toEqual([]);

  refresh();
  await Bun.sleep(0);
  expect(calls).toBe(2);
  expect(seen).toEqual(["main"]);
});
