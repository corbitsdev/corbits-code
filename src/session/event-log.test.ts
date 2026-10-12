import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isSessionId } from "./index.js";
import {
  EVENT_LOG_FILE,
  SESSION_EVENT_LOG_ENV,
  createEventStreamWriter,
  isSessionEventLogEnabled,
  openEventStreamWriter,
} from "./event-log.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "event-stream-"));
}

function rawLines(dir: string, file: string = EVENT_LOG_FILE): string[] {
  const raw = fs.readFileSync(path.join(dir, file), "utf8");
  return raw.split("\n").filter((line) => line.length > 0);
}

describe("createEventStreamWriter", () => {
  test("appends one JSON line per event with generated UUIDv7 id, seq, ts, payload", async () => {
    const dir = tempDir();
    const writer = createEventStreamWriter(dir, {
      now: () => 1_700_000_000_000,
    });
    const first = await writer.append({
      type: "session.started",
      payload: { task: "hello" },
    });
    const second = await writer.append({ id: "fixed-id", type: "turn.done" });

    expect(isSessionId(first.id)).toBe(true);
    expect(first).toEqual({
      id: first.id,
      type: "session.started",
      seq: 0,
      ts: 1_700_000_000_000,
      payload: { task: "hello" },
    });
    expect(second.id).toBe("fixed-id");
    expect(second.seq).toBe(1);

    const lines = rawLines(dir);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      expect(line.endsWith("\n")).toBe(false);
    }
    expect(lines[0]).toBe(JSON.stringify(first));
  });

  test("preserves append order and assigns seq in order", async () => {
    const dir = tempDir();
    const writer = createEventStreamWriter(dir);
    const ids = ["a", "b", "c", "d", "e"];
    for (const id of ids) {
      await writer.append({ id, type: "event" });
    }

    const records = await writer.readFrom(-1);
    expect(records.map((r) => r.id)).toEqual(ids);
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);

    const lines = rawLines(dir).map(
      (line) => JSON.parse(line) as { id: string },
    );
    expect(lines.map((l) => l.id)).toEqual(ids);
  });

  test("keeps parentId linkage resolvable across the stream", async () => {
    const dir = tempDir();
    const writer = createEventStreamWriter(dir);
    await writer.append({ id: "root", type: "session.started" });
    await writer.append({ id: "turn-1", parentId: "root", type: "turn.done" });
    await writer.append({
      id: "turn-2",
      parentId: "turn-1",
      type: "turn.done",
    });

    const records = await writer.readFrom(-1);
    expect(records.map((r) => r.parentId)).toEqual([
      undefined,
      "root",
      "turn-1",
    ]);

    const byId = new Map(records.map((r) => [r.id, r]));
    const chain: string[] = [];
    let cursor: string | undefined = "turn-2";
    while (cursor !== undefined) {
      const record = byId.get(cursor);
      if (record === undefined) throw new Error(`missing event ${cursor}`);
      chain.push(record.id);
      cursor = record.parentId;
    }
    expect(chain).toEqual(["turn-2", "turn-1", "root"]);
  });

  test("a reopened writer continues seq and preserves prior events", async () => {
    const dir = tempDir();
    const first = createEventStreamWriter(dir);
    await first.append({ id: "evt-1", type: "session.started" });
    await first.append({ id: "evt-2", type: "turn.done" });
    await first.flush();

    const reopened = createEventStreamWriter(dir);
    const third = await reopened.append({ id: "evt-3", type: "turn.done" });
    expect(third.seq).toBe(2);

    const records = await reopened.readFrom(-1);
    expect(records.map((r) => r.id)).toEqual(["evt-1", "evt-2", "evt-3"]);
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(await reopened.latestCursor()).toBe(2);
  });

  test("flush awaits previously appended events", async () => {
    const dir = tempDir();
    const writer = createEventStreamWriter(dir);
    await writer.append({ id: "a", type: "event" });
    await writer.append({ id: "b", type: "event" });
    await writer.flush();
    expect(rawLines(dir)).toHaveLength(2);
  });

  test("concurrent writers on one dir cannot duplicate seqs or interleave", async () => {
    const dir = tempDir();
    const writerA = createEventStreamWriter(dir);
    const writerB = createEventStreamWriter(dir);
    const events = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0 ? writerA : writerB).append({
          id: `evt-${i}`,
          type: "event",
        }),
      ),
    );

    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(Math.max(...seqs)).toBe(seqs.length - 1);

    const records = await writerA.readFrom(-1);
    expect(records).toHaveLength(20);
    expect(new Set(records.map((r) => r.id)).size).toBe(20);
    expect(records.map((r) => r.seq)).toEqual([...seqs].sort((a, b) => a - b));
  });

  test("a torn tail on reopen is dropped: reads succeed and append gets a contiguous seq", async () => {
    const dir = tempDir();
    const writer = createEventStreamWriter(dir);
    await writer.append({ id: "evt-1", type: "session.started" });
    await writer.flush();

    fs.appendFileSync(
      path.join(dir, EVENT_LOG_FILE),
      '{"id":"torn","type":"eve',
    );

    const reader = createEventStreamWriter(dir);
    expect((await reader.readFrom(-1)).map((r) => r.id)).toEqual(["evt-1"]);
    expect(await reader.latestCursor()).toBe(0);

    const reopened = createEventStreamWriter(dir);
    const next = await reopened.append({ id: "evt-2", type: "turn.done" });
    expect(next.seq).toBe(1);

    const records = await reopened.readFrom(-1);
    expect(records.map((r) => r.id)).toEqual(["evt-1", "evt-2"]);
    expect(records.map((r) => r.seq)).toEqual([0, 1]);
  });

  test("readFrom returns only events past the cursor", async () => {
    const dir = tempDir();
    const writer = createEventStreamWriter(dir);
    for (const id of ["a", "b", "c", "d"]) {
      await writer.append({ id, type: "event" });
    }
    const after = await writer.readFrom(1);
    expect(after.map((r) => r.id)).toEqual(["c", "d"]);
    expect(await writer.readFrom(3)).toEqual([]);
  });

  test("latestCursor reports -1 on an empty log and the last seq after appends", async () => {
    const dir = tempDir();
    const writer = createEventStreamWriter(dir);
    expect(await writer.latestCursor()).toBe(-1);
    await writer.append({ id: "a", type: "event" });
    await writer.append({ id: "b", type: "event" });
    expect(await writer.latestCursor()).toBe(1);
  });

  test("projectTurns returns turn events in order", async () => {
    const dir = tempDir();
    const writer = createEventStreamWriter(dir);
    await writer.append({ id: "s", type: "session.started" });
    await writer.append({
      id: "t1",
      type: "turn.user",
      payload: { text: "hi" },
    });
    await writer.append({
      id: "m",
      type: "model.selected",
      payload: { model: "x" },
    });
    await writer.append({
      id: "t2",
      type: "turn.assistant",
      payload: { text: "yo" },
    });

    const turns = (await writer.projectTurns()) as { id: string }[];
    expect(turns.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  test("projectPrompt joins text payloads in order", async () => {
    const dir = tempDir();
    const writer = createEventStreamWriter(dir);
    await writer.append({
      id: "a",
      type: "turn.user",
      payload: { text: "first" },
    });
    await writer.append({
      id: "b",
      type: "turn.user",
      payload: { text: "second" },
    });
    await writer.append({ id: "c", type: "turn.user" });
    expect(await writer.projectPrompt()).toBe("first\nsecond");
  });

  test("backfillFromLegacy appends turns.jsonl as chained turn.legacy events", async () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "turns.jsonl"),
      '{"role":"user","text":"one"}\n{"role":"assistant","text":"two"}\n',
    );
    const writer = createEventStreamWriter(dir);
    expect(await writer.backfillFromLegacy()).toBe(2);

    const records = await writer.readFrom(-1);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.type === "turn.legacy")).toBe(true);
    const [first, second] = records;
    if (first === undefined || second === undefined) {
      throw new Error("expected two backfilled events");
    }
    expect(first.parentId).toBeUndefined();
    expect(second.parentId).toBe(first.id);
    expect((first.payload as { record: unknown }).record).toEqual({
      role: "user",
      text: "one",
    });
  });

  test("backfillFromLegacy returns 0 when turns.jsonl is absent", async () => {
    const dir = tempDir();
    const writer = createEventStreamWriter(dir);
    expect(await writer.backfillFromLegacy()).toBe(0);
  });

  test("backfillFromLegacy is idempotent across re-runs", async () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "turns.jsonl"),
      '{"role":"user","text":"one"}\n{"role":"assistant","text":"two"}\n',
    );
    const writer = createEventStreamWriter(dir);
    expect(await writer.backfillFromLegacy()).toBe(2);
    expect(await writer.backfillFromLegacy()).toBe(0);

    const records = await writer.readFrom(-1);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.type)).toEqual(["turn.legacy", "turn.legacy"]);
  });

  test("backfillFromLegacy skips only already-backfilled lines", async () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "turns.jsonl"),
      '{"role":"user","text":"one"}\n{"role":"assistant","text":"two"}\n',
    );
    const writer = createEventStreamWriter(dir);
    expect(await writer.backfillFromLegacy()).toBe(2);

    fs.appendFileSync(
      path.join(dir, "turns.jsonl"),
      '{"role":"user","text":"three"}\n',
    );
    expect(await writer.backfillFromLegacy()).toBe(1);

    const records = await writer.readFrom(-1);
    expect(records).toHaveLength(3);
  });
});

describe("event stream flag gating", () => {
  test("isSessionEventLogEnabled honors settings and env, with explicit off", () => {
    expect(isSessionEventLogEnabled({})).toBe(false);
    expect(
      isSessionEventLogEnabled({ settings: { sessionEventLog: true } }),
    ).toBe(true);
    expect(
      isSessionEventLogEnabled({ settings: { sessionEventLog: false } }),
    ).toBe(false);
    expect(
      isSessionEventLogEnabled({ flagEnv: { [SESSION_EVENT_LOG_ENV]: "1" } }),
    ).toBe(true);
    expect(
      isSessionEventLogEnabled({
        flagEnv: { [SESSION_EVENT_LOG_ENV]: "true" },
      }),
    ).toBe(true);
    for (const off of ["", "0", "false", "no", "off"]) {
      expect(
        isSessionEventLogEnabled({
          settings: { sessionEventLog: true },
          flagEnv: { [SESSION_EVENT_LOG_ENV]: off },
        }),
      ).toBe(false);
    }
  });

  test("openEventStreamWriter returns null (inert) when the flag is off", () => {
    const dir = tempDir();
    expect(
      openEventStreamWriter(dir, { settings: { sessionEventLog: false } }),
    ).toBeNull();
    expect(
      openEventStreamWriter(dir, {
        flagEnv: { [SESSION_EVENT_LOG_ENV]: "off" },
      }),
    ).toBeNull();
    expect(fs.existsSync(path.join(dir, EVENT_LOG_FILE))).toBe(false);
  });

  test("openEventStreamWriter returns a live writer when the flag is on", async () => {
    const dir = tempDir();
    const writer = openEventStreamWriter(dir, {
      settings: { sessionEventLog: true },
    });
    expect(writer).not.toBeNull();
    if (writer === null)
      throw new Error("flag-enabled writer should not be null");
    await writer.append({ type: "session.started" });
    expect(await writer.readFrom(-1)).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, EVENT_LOG_FILE))).toBe(true);
  });
});
