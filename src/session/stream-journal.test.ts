import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";

import {
  appendCycleText,
  createCycleTextRecorder,
  CYCLE_TEXT_CAP_CHARS,
  PARTIAL_FILE,
} from "./stream-journal.js";

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

function thinkingDelta(token: string): ReactorEmittedEvent {
  return { type: "inference.thinking.delta", data: { token } } as unknown as ReactorEmittedEvent;
}

async function readPartialRecords(): Promise<
  {
    reason: string;
    text: string;
    thinkingText?: string;
    thinkingChars?: number;
    error?: { category?: string; message?: string; statusCode?: number };
  }[]
> {
  const raw = await readFile(join(dir, PARTIAL_FILE), "utf8");
  return raw
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          reason: string;
          text: string;
          thinkingText?: string;
          thinkingChars?: number;
          error?: { category?: string; message?: string; statusCode?: number };
        },
    );
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
    await recorder.flush("cancelled");

    const records = await readPartialRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.reason).toBe("cancelled");
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
    expect(records[0]?.error?.category).toBe("aborted");
    expect(records[0]?.error?.message).toBe("aborted");
  });

  test("inference.error with empty cycle text still writes a partial with the error payload", async () => {
    // Observed live: ~20 unattributable episodes had inference.error with no
    // streamed text. The partial must still land so category/message survive.
    const recorder = createCycleTextRecorder(() => dir);
    recorder.handleEvent({
      type: "inference.error",
      data: {
        error: { category: "rate_limit", message: "429 too many requests", statusCode: 429 },
      },
    } as unknown as ReactorEmittedEvent);

    await Bun.sleep(20);
    const records = await readPartialRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.reason).toBe("inference-error");
    expect(records[0]?.text).toBe("");
    expect(records[0]?.error).toEqual({
      category: "rate_limit",
      message: "429 too many requests",
      statusCode: 429,
    });
  });

  test("dispose flushes the entry snapshot with the given reason and returns it", async () => {
    const recorder = createCycleTextRecorder(() => dir);
    recorder.handleEvent(delta("dead cycle text"));
    const snapshot = await recorder.dispose("interrupted");

    expect(snapshot).toBe("dead cycle text");
    const records = await readPartialRecords();
    expect(records[0]?.reason).toBe("interrupted");
    expect(records[0]?.text).toBe("dead cycle text");
  });

  test('events after dispose are ignored and a second dispose returns "" writing nothing', async () => {
    const recorder = createCycleTextRecorder(() => dir);
    recorder.handleEvent(delta("first"));
    await recorder.dispose("exit");

    recorder.handleEvent(delta("stray"));
    expect(recorder.text()).toBe("");

    const second = await recorder.dispose("crashed");
    expect(second).toBe("");

    const records = await readPartialRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.reason).toBe("exit");
  });

  test("dispose with drain awaits the drain before writing", async () => {
    const recorder = createCycleTextRecorder(() => dir);
    recorder.handleEvent(delta("buffered text"));

    let resolveDrain: () => void = () => {};
    const drain = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });

    const disposePromise = recorder.dispose("cancelled", { drain });
    await Bun.sleep(10);
    await expect(readFile(join(dir, PARTIAL_FILE), "utf8")).rejects.toThrow();

    resolveDrain();
    await disposePromise;
    const records = await readPartialRecords();
    expect(records[0]?.text).toBe("buffered text");
  });

  test("buffers thinking deltas separately from text and flushes both", async () => {
    const recorder = createCycleTextRecorder(() => dir);
    recorder.handleEvent(delta("visible reply"));
    recorder.handleEvent(thinkingDelta("0/1 1/2 2/3 "));
    expect(recorder.text()).toBe("visible reply");
    expect(recorder.thinkingText()).toBe("0/1 1/2 2/3 ");

    await recorder.flush("cancelled");
    const records = await readPartialRecords();
    expect(records[0]?.text).toBe("visible reply");
    expect(records[0]?.thinkingText).toBe("0/1 1/2 2/3 ");
    expect(recorder.thinkingText()).toBe("");
  });

  test("a thinking-only loop still writes a partial record with the looped window", async () => {
    // No visible text ever streamed (the observed live failure): the salvage
    // must still be diagnosable from thinkingText alone.
    const recorder = createCycleTextRecorder(() => dir);
    recorder.handleEvent(thinkingDelta("0/1 1/2 2/3 3/4 4/5 "));
    const snapshot = await recorder.dispose("cancelled");

    expect(snapshot).toBe("");
    const records = await readPartialRecords();
    expect(records[0]?.reason).toBe("cancelled");
    expect(records[0]?.text).toBe("");
    expect(records[0]?.thinkingText).toBe("0/1 1/2 2/3 3/4 4/5 ");
  });

  test("a turn boundary resets both the text and thinking buffers", () => {
    const recorder = createCycleTextRecorder(() => dir);
    recorder.handleEvent(delta("hello"));
    recorder.handleEvent(thinkingDelta("thinking"));
    recorder.handleEvent({ type: "inference.done", data: {} } as unknown as ReactorEmittedEvent);
    expect(recorder.text()).toBe("");
    expect(recorder.thinkingText()).toBe("");
  });

  test("reset reopens a closed recorder so new deltas buffer and flush normally", async () => {
    const recorder = createCycleTextRecorder(() => dir);
    await recorder.dispose("rotation");
    recorder.reset();

    recorder.handleEvent(delta("fresh session text"));
    await recorder.flush("cancelled");

    const records = await readPartialRecords();
    expect(records[0]?.reason).toBe("cancelled");
    expect(records[0]?.text).toBe("fresh session text");
  });

  test("inference.error auto-flush after dispose writes nothing", async () => {
    const recorder = createCycleTextRecorder(() => dir);
    recorder.handleEvent(delta("before dispose"));
    await recorder.dispose("interrupted");

    recorder.handleEvent({
      type: "inference.error",
      data: { error: { category: "aborted", message: "aborted" } },
    } as unknown as ReactorEmittedEvent);
    await Bun.sleep(20);

    const records = await readPartialRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.reason).toBe("interrupted");
  });
});

describe("successful-send teardown", () => {
  test("drain-then-dispose writes nothing when the final done arrived on the stream", async () => {
    // Mirrors the exec success path: send resolves on the connector reply
    // while inference.done may still be queued. The caller must drain first;
    // disposing before the drain would snapshot the full successful reply
    // and persist it as a spurious partial.
    const recorder = createCycleTextRecorder(() => dir);
    recorder.handleEvent(delta("final assistant answer"));

    const drain = (async () => {
      await Bun.sleep(5);
      recorder.handleEvent({
        type: "inference.done",
        data: {},
      } as unknown as ReactorEmittedEvent);
    })();

    await drain;
    const salvaged = await recorder.dispose("cancelled");
    expect(salvaged).toBe("");
    await expect(readFile(join(dir, PARTIAL_FILE), "utf8")).rejects.toThrow();
  });
});

describe("appendCycleText", () => {
  test("keeps only the tail past the cap", () => {
    const text = appendCycleText("a".repeat(10), "b".repeat(10), 15);
    expect(text).toHaveLength(15);
    expect(text.endsWith("b".repeat(10))).toBe(true);
  });

  test("appends unchanged under the cap", () => {
    expect(appendCycleText("abc", "def", 100)).toBe("abcdef");
  });

  test("respects the default cap", () => {
    const text = appendCycleText("x".repeat(CYCLE_TEXT_CAP_CHARS), "y");
    expect(text).toHaveLength(CYCLE_TEXT_CAP_CHARS);
    expect(text.endsWith("y")).toBe(true);
  });
});
