import { describe, expect, test } from "bun:test";

import {
  createShellOutputFeed,
  SHELL_FEED_LIMIT_BYTES,
} from "./shell-output-feed.js";

describe("shell output feed", () => {
  test("snapshots appended chunks in order", () => {
    const feed = createShellOutputFeed();
    feed.append("hello ");
    feed.append("world\n");
    expect(feed.snapshot()).toBe("hello world\n");
    feed.clear();
    expect(feed.snapshot()).toBe("");
  });

  test("keeps the tail under a burst larger than the bound", () => {
    const feed = createShellOutputFeed(1024);
    const burst = Array.from(
      { length: 128 },
      (_, i) => `line ${i} padding\n`,
    ).join("");
    expect(burst.length).toBeGreaterThan(1024);
    feed.append(burst);
    const snapshot = feed.snapshot();
    expect(new TextEncoder().encode(snapshot).length).toBeLessThanOrEqual(1024);
    // The oldest lines are the ones dropped: the snapshot ends at the newest.
    expect(snapshot.endsWith("line 127 padding\n")).toBe(true);
  });

  test("the default bound is 8 KiB", () => {
    const feed = createShellOutputFeed();
    feed.append("x".repeat(SHELL_FEED_LIMIT_BYTES + 1));
    expect(
      new TextEncoder().encode(feed.snapshot()).length,
    ).toBeLessThanOrEqual(SHELL_FEED_LIMIT_BYTES);
  });

  test("empty appends change nothing", () => {
    const feed = createShellOutputFeed();
    feed.append("");
    expect(feed.snapshot()).toBe("");
  });
});
