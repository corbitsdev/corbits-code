import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { generateSessionId, initSessionDir } from "./index.js";
import { appendSentMessage } from "./sent-messages.js";
import { isGenericSessionTask, resolveSessionLabel, truncateSessionLabel } from "./session-label.js";

let cwd = "";

beforeEach(async () => {
  cwd = join(tmpdir(), `intercode-session-label-${Date.now()}`);
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

test("truncateSessionLabel collapses whitespace", () => {
  expect(truncateSessionLabel("  fix   resume\nflow  ")).toBe("fix resume flow");
});

test("resolveSessionLabel uses run.json task when set", async () => {
  const id = generateSessionId();
  await initSessionDir(cwd, id);
  const label = await resolveSessionLabel(cwd, id, "Ship sent-history");
  expect(label).toBe("Ship sent-history");
});

test("resolveSessionLabel falls back to first sent message", async () => {
  const id = generateSessionId();
  await initSessionDir(cwd, id);
  await appendSentMessage(cwd, id, "How do we name sessions?");
  const label = await resolveSessionLabel(cwd, id, "(conversation)");
  expect(label).toBe("How do we name sessions?");
});

test("isGenericSessionTask", () => {
  expect(isGenericSessionTask("(conversation)")).toBe(true);
  expect(isGenericSessionTask("Real title")).toBe(false);
});