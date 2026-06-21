import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { generateSessionId, initSessionDir } from "./index.js";
import { appendSentMessage, loadSentMessages } from "./sent-messages.js";

describe("sent-messages", () => {
  let cwd: string;
  let sessionId: string;

  afterEach(async () => {
    if (cwd !== undefined) await rm(cwd, { recursive: true, force: true });
  });

  test("append and load per session", async () => {
    cwd = await mkdtemp(join(tmpdir(), "sent-msg-"));
    sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId);

    expect(await loadSentMessages(cwd, sessionId)).toEqual([]);
    await appendSentMessage(cwd, sessionId, "  hello  ");
    await appendSentMessage(cwd, sessionId, "world");
    expect(await loadSentMessages(cwd, sessionId)).toEqual(["hello", "world"]);
  });
});