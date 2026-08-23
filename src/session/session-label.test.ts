import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { generateSessionId, initSessionDir } from "./index.js";
import { appendSentMessage } from "./sent-messages.js";
import {
  isGenericSessionTask,
  resolveSessionLabel,
  truncateSessionLabel,
} from "./session-label.js";

let cwd = "";
let home = "";

beforeEach(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  cwd = join(tmpdir(), `corbits-session-label-${stamp}`);
  home = join(tmpdir(), `corbits-session-label-home-${stamp}`);
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("truncateSessionLabel collapses whitespace", () => {
  expect(truncateSessionLabel("  fix   resume\nflow  ")).toBe("fix resume flow");
});

test("resolveSessionLabel uses run.json task when set", async () => {
  const id = generateSessionId();
  await initSessionDir(cwd, id, home);
  const label = await resolveSessionLabel(cwd, id, "Ship sent-history", home);
  expect(label).toBe("Ship sent-history");
});

test("resolveSessionLabel falls back to first sent message", async () => {
  const id = generateSessionId();
  await initSessionDir(cwd, id, home);
  await appendSentMessage(cwd, id, "How do we name sessions?", home);
  const label = await resolveSessionLabel(cwd, id, "(conversation)", home);
  expect(label).toBe("How do we name sessions?");
});

test("isGenericSessionTask", () => {
  expect(isGenericSessionTask("(conversation)")).toBe(true);
  expect(isGenericSessionTask("Real title")).toBe(false);
});
