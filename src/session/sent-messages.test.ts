import { afterEach, describe, expect, test } from "bun:test";

import { createTempDirs, type TempDirs } from "../../testkit/temporary-dirs.js";
import { generateSessionId, initSessionDir } from "./index.js";
import { appendSentMessage, loadSentMessages } from "./sent-messages.js";

describe("sent-messages", () => {
  let workspace: TempDirs | undefined;

  afterEach(() => {
    workspace?.cleanup();
  });

  test("append and load per session", async () => {
    const { cwd, home } = (workspace = createTempDirs(
      "sent-msg-",
      "sent-msg-home-",
    ));
    const sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId, home);

    expect(await loadSentMessages(cwd, sessionId, home)).toEqual([]);
    await appendSentMessage(cwd, sessionId, "  hello  ", home);
    await appendSentMessage(cwd, sessionId, "world", home);
    expect(await loadSentMessages(cwd, sessionId, home)).toEqual([
      "hello",
      "world",
    ]);
  });

  test("load keeps only the last 20 messages", async () => {
    const { cwd, home } = (workspace = createTempDirs(
      "sent-msg-",
      "sent-msg-home-",
    ));
    const sessionId = generateSessionId();
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
