import { describe, expect, jest, test } from "bun:test";

import { watchGitBranch } from "./workspace-watch";

/** The retired idle poll. An idle window of several of these must not spawn git. */
const FORMER_POLL_INTERVAL_MS = 5_000;

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("watchGitBranch", () => {
  test("reports the branch on the first lookup", async () => {
    const seen: (string | null)[] = [];
    const watch = watchGitBranch({
      cwd: "/repo",
      onBranch: (b) => seen.push(b),
      fetchBranch: async () => "main",
    });
    await flush();
    expect(seen).toEqual(["main"]);
    watch.stop();
  });

  test("one refresh during an outstanding lookup runs a single follow-up and reports the later branch", async () => {
    let calls = 0;
    const pending: ((branch: string | null) => void)[] = [];
    const seen: (string | null)[] = [];
    const watch = watchGitBranch({
      cwd: "/repo",
      onBranch: (b) => seen.push(b),
      fetchBranch: () => {
        calls += 1;
        return new Promise((resolve) => {
          pending.push(resolve);
        });
      },
    });
    watch.refresh();
    watch.refresh();
    expect(calls).toBe(1);

    pending[0]?.("main");
    await flush();
    expect(calls).toBe(2);
    expect(seen).toEqual(["main"]);

    pending[1]?.("topic");
    await flush();
    expect(calls).toBe(2);
    expect(seen).toEqual(["main", "topic"]);
    watch.stop();
  });

  test("a null result after a known branch is not reported", async () => {
    const seen: (string | null)[] = [];
    let branch: string | null = "main";
    const watch = watchGitBranch({
      cwd: "/repo",
      onBranch: (b) => seen.push(b),
      fetchBranch: async () => branch,
    });
    await flush();
    branch = null;
    watch.refresh();
    await flush();
    expect(seen).toEqual(["main"]);
    watch.stop();
  });

  test("a lookup that lands after stop is dropped", async () => {
    const seen: (string | null)[] = [];
    const pending: ((branch: string | null) => void)[] = [];
    const watch = watchGitBranch({
      cwd: "/repo",
      onBranch: (b) => seen.push(b),
      fetchBranch: () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    });
    watch.stop();
    pending[0]?.("main");
    await flush();
    expect(seen).toEqual([]);
  });

  test("a failed lookup neither reports nor wedges the guard", async () => {
    let calls = 0;
    const seen: (string | null)[] = [];
    const watch = watchGitBranch({
      cwd: "/repo",
      onBranch: (b) => seen.push(b),
      fetchBranch: async () => {
        calls += 1;
        throw new Error("git exploded");
      },
    });
    await flush();
    expect(seen).toEqual([]);
    watch.refresh();
    await flush();
    expect(calls).toBe(2);
    watch.stop();
  });

  test("an idle window of several former intervals spawns git zero times, and refresh still updates", async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      let branch = "main";
      const seen: (string | null)[] = [];
      const watch = watchGitBranch({
        cwd: "/repo",
        onBranch: (b) => seen.push(b),
        fetchBranch: async () => {
          calls += 1;
          return branch;
        },
      });
      await flush();
      expect(seen).toEqual(["main"]);
      const afterStart = calls;

      jest.advanceTimersByTime(FORMER_POLL_INTERVAL_MS * 6);
      await flush();
      expect(calls).toBe(afterStart);

      branch = "topic";
      watch.refresh();
      await flush();
      expect(calls).toBe(afterStart + 1);
      expect(seen).toEqual(["main", "topic"]);
      watch.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});
