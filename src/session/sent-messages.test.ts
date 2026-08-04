import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { generateSessionId, initSessionDir } from "./index.js";
import { appendSentMessage, loadSentMessages } from "./sent-messages.js";

describe("sent-messages", () => {
  let cwd: string;
  let home: string;
  let sessionId: string;

  afterEach(async () => {
    if (cwd !== undefined) await rm(cwd, { recursive: true, force: true });
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });

  test("append and load per session", async () => {
    cwd = await mkdtemp(join(tmpdir(), "sent-msg-"));
    home = await mkdtemp(join(tmpdir(), "sent-msg-home-"));
    sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId, home);

    expect(await loadSentMessages(cwd, sessionId, home)).toEqual([]);
    await appendSentMessage(cwd, sessionId, "  hello  ", home);
    await appendSentMessage(cwd, sessionId, "world", home);
    expect(await loadSentMessages(cwd, sessionId, home)).toEqual(["hello", "world"]);
  });

  test("load keeps only the last 20 messages", async () => {
    cwd = await mkdtemp(join(tmpdir(), "sent-msg-"));
    home = await mkdtemp(join(tmpdir(), "sent-msg-home-"));
    sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId, home);
    for (let i = 0; i < 25; i++) {
      await appendSentMessage(cwd, sessionId, `msg-${i}`, home);
    }
    const loaded = await loadSentMessages(cwd, sessionId, home);
    expect(loaded).toHaveLength(20);
    expect(loaded[0]).toBe("msg-5");
    expect(loaded[19]).toBe("msg-24");
  });
});
