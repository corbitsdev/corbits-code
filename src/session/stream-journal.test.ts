import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";

import { createCycleTextRecorder, PARTIAL_FILE } from "./stream-journal.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "stream-journal-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function delta(token: string): ReactorEmittedEvent {
  return { type: "inference.text.delta", data: { token } } as unknown as ReactorEmittedEvent;
}

async function readPartialRecords(): Promise<Array<{ reason: string; text: string }>> {
  const raw = await readFile(join(dir, PARTIAL_FILE), "utf8");
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { reason: string; text: string });
}

describe("createCycleTextRecorder", () => {
  test("buffers deltas and writes nothing on the happy path", async () => {
    const recorder = createCycleTextRecorder(() => dir);
    recorder.handleEvent(delta("hello "));
    recorder.handleEvent(delta("world"));
    expect(recorder.text()).toBe("hello world");

    recorder.handleEvent({ type: "inference.done", data: {} } as unknown as ReactorEmittedEvent);
    expect(recorder.text()).toBe("");
    await expect(readFile(join(dir, PARTIAL_FILE), "utf8")).rejects.toThrow();
  });

  test("flush writes the buffer with a reason and resets", async () => {
    const recorder = createCycleTextRecorder(() => dir);
    recorder.handleEvent(delta("looping output"));
    await recorder.flush("repetition");

    const records = await readPartialRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.reason).toBe("repetition");
    expect(records[0]?.text).toBe("looping output");
    expect(recorder.text()).toBe("");
  });

  test("flush with an empty buffer writes nothing", async () => {
    const recorder = createCycleTextRecorder(() => dir);
    await recorder.flush("cancelled");
    await expect(readFile(join(dir, PARTIAL_FILE), "utf8")).rejects.toThrow();
  });

  test("an inference.error event flushes the buffer", async () => {
    const recorder = createCycleTextRecorder(() => dir);
    recorder.handleEvent(delta("partial before failure"));
    recorder.handleEvent({
      type: "inference.error",
      data: { error: { category: "aborted", message: "aborted" } },
    } as unknown as ReactorEmittedEvent);

    await Bun.sleep(20);
    const records = await readPartialRecords();
    expect(records[0]?.reason).toBe("inference-error");
    expect(records[0]?.text).toBe("partial before failure");
  });

  test("uses the injected append function for capping", () => {
    const recorder = createCycleTextRecorder(() => dir, (text, token) => (text + token).slice(-5));
    recorder.handleEvent(delta("abcdefgh"));
    expect(recorder.text()).toBe("defgh");
  });

  test("an inference.error auto-flush uses resolveErrorFlushReason for the record's reason", async () => {
    const recorder = createCycleTextRecorder(() => dir, undefined, {
      resolveErrorFlushReason: () => "deadline",
    });
    recorder.handleEvent(delta("partial before deadline"));
    recorder.handleEvent({
      type: "inference.error",
      data: { error: { category: "aborted", message: "aborted" } },
    } as unknown as ReactorEmittedEvent);

    await Bun.sleep(20);
    const records = await readPartialRecords();
    expect(records[0]?.reason).toBe("deadline");
    expect(records[0]?.text).toBe("partial before deadline");
  });

  test("lastFlushedText returns the most recent non-empty flush and the buffer resets", async () => {
    const recorder = createCycleTextRecorder(() => dir);
    expect(recorder.lastFlushedText()).toBe("");

    recorder.handleEvent(delta("first flush text"));
    await recorder.flush("cancelled");
    expect(recorder.lastFlushedText()).toBe("first flush text");
    expect(recorder.text()).toBe("");

    // A subsequent empty flush must not clobber the last non-empty flush.
    await recorder.flush("cancelled");
    expect(recorder.lastFlushedText()).toBe("first flush text");

    recorder.handleEvent(delta("second flush text"));
    await recorder.flush("deadline");
    expect(recorder.lastFlushedText()).toBe("second flush text");
  });
});
