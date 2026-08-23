import { describe, expect, test } from "bun:test";

import { watchGitBranch } from "./workspace-watch";

function fakeClock(): {
  readonly schedule: (tick: () => void, intervalMs: number) => () => void;
  readonly tick: () => void;
} {
  let ticker: (() => void) | null = null;
  return {
    schedule: (fn) => {
      ticker = fn;
      return () => {
        ticker = null;
      };
    },
    tick: () => ticker?.(),
  };
}

describe("watchGitBranch", () => {
  test("reports the branch on the first lookup, before any tick", async () => {
    const seen: (string | null)[] = [];
    const clock = fakeClock();
    const stop = watchGitBranch({
      cwd: "/repo",
      onBranch: (b) => seen.push(b),
      fetchBranch: async () => "main",
      schedule: clock.schedule,
    });
    await Promise.resolve();
    expect(seen).toEqual(["main"]);
    stop();
  });

  test("skips a tick while the previous lookup is still outstanding", async () => {
    let calls = 0;
    const pending: ((branch: string | null) => void)[] = [];
    const clock = fakeClock();
    const stop = watchGitBranch({
      cwd: "/repo",
      onBranch: () => {},
      fetchBranch: () => {
        calls += 1;
        return new Promise((resolve) => {
          pending.push(resolve);
        });
      },
      schedule: clock.schedule,
    });
    clock.tick();
    clock.tick();
    expect(calls).toBe(1);

    pending[0]?.("main");
    await Promise.resolve();
    clock.tick();
    expect(calls).toBe(2);
    stop();
  });

  test("a lookup that lands after stop is dropped", async () => {
    const seen: (string | null)[] = [];
    const pending: ((branch: string | null) => void)[] = [];
    const clock = fakeClock();
    const stop = watchGitBranch({
      cwd: "/repo",
      onBranch: (b) => seen.push(b),
      fetchBranch: () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
      schedule: clock.schedule,
    });
    stop();
    pending[0]?.("main");
    await Promise.resolve();
    expect(seen).toEqual([]);
  });

  test("a failed lookup neither reports nor wedges the guard", async () => {
    let calls = 0;
    const seen: (string | null)[] = [];
    const clock = fakeClock();
    const stop = watchGitBranch({
      cwd: "/repo",
      onBranch: (b) => seen.push(b),
      fetchBranch: async () => {
        calls += 1;
        throw new Error("git exploded");
      },
      schedule: clock.schedule,
    });
    await Promise.resolve();
    expect(seen).toEqual([]);
    clock.tick();
    expect(calls).toBe(2);
    stop();
  });
});
