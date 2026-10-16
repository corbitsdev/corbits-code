import { describe, expect, test } from "bun:test";

import {
  createShellOutputFeed,
  createShellOutputFeedMap,
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

  test("subscribe fires on append and clear, not on an empty clear", () => {
    const feed = createShellOutputFeed();
    let notices = 0;
    const stop = feed.subscribe(() => {
      notices += 1;
    });
    feed.append("hello");
    feed.clear();
    feed.clear();
    expect(notices).toBe(2);
    stop();
    feed.append("again");
    expect(notices).toBe(2);
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
});

describe("shell output feed map", () => {
  test("isolates tails per call and keeps the 8 KiB bound on each", () => {
    const feeds = createShellOutputFeedMap();
    const a = feeds.forCall("a");
    const b = feeds.forCall("b");
    a.append("alpha\n");
    b.append("beta\n");
    expect(feeds.get("a")?.snapshot()).toBe("alpha\n");
    expect(feeds.get("b")?.snapshot()).toBe("beta\n");
    a.append("x".repeat(SHELL_FEED_LIMIT_BYTES + 1));
    expect(new TextEncoder().encode(a.snapshot()).length).toBeLessThanOrEqual(
      SHELL_FEED_LIMIT_BYTES,
    );
    expect(feeds.get("b")?.snapshot()).toBe("beta\n");
    feeds.drop("a");
    expect(feeds.get("a")).toBeUndefined();
    expect(feeds.get("b")?.snapshot()).toBe("beta\n");
  });

  test("the map hears appends on feeds created after subscribe", () => {
    const feeds = createShellOutputFeedMap();
    let notices = 0;
    feeds.subscribe(() => {
      notices += 1;
    });
    feeds.forCall("a").append("one");
    feeds.forCall("b").append("two");
    expect(notices).toBe(2);
  });
});
