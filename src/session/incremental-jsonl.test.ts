import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIncrementalJSONLWriter } from "./incremental-jsonl.js";

function fullSnapshot(records: readonly unknown[]): string {
  if (records.length === 0) return "";
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-"));
  return path.join(dir, "turns.jsonl");
}

describe("createIncrementalJSONLWriter", () => {
  test("matches a full rewrite across append-only growth", async () => {
    const file = tempFile();
    const write = createIncrementalJSONLWriter(file);
    const turns: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      turns.push({ role: "user", text: `turn ${i}` });
      await write(turns);
      expect(fs.readFileSync(file, "utf8")).toBe(fullSnapshot(turns));
    }
  });

  test("handles a history rewrite that replaces earlier records", async () => {
    const file = tempFile();
    const write = createIncrementalJSONLWriter(file);
    const a = { id: 1 }, b = { id: 2 }, c = { id: 3 };
    await write([a, b, c]);
    const compacted = [{ id: "summary" }, c];
    await write(compacted);
    expect(fs.readFileSync(file, "utf8")).toBe(fullSnapshot(compacted));
  });

  test("detects in-place mutation of the newest record", async () => {
    const file = tempFile();
    const write = createIncrementalJSONLWriter(file);
    const last: { content: string[] } = { content: ["partial"] };
    await write([{ id: 1 }, last]);
    last.content.push("more");
    await write([{ id: 1 }, last]);
    expect(fs.readFileSync(file, "utf8")).toBe(fullSnapshot([{ id: 1 }, last]));
  });

  test("shrinks the file when records are removed", async () => {
    const file = tempFile();
    const write = createIncrementalJSONLWriter(file);
    const a = { id: 1 }, b = { id: 2 };
    await write([a, b]);
    await write([a]);
    expect(fs.readFileSync(file, "utf8")).toBe(fullSnapshot([a]));
  });

  test("writes an empty file for no records", async () => {
    const file = tempFile();
    const write = createIncrementalJSONLWriter(file);
    await write([]);
    expect(fs.readFileSync(file, "utf8")).toBe("");
    await write([{ id: 1 }]);
    expect(fs.readFileSync(file, "utf8")).toBe(fullSnapshot([{ id: 1 }]));
  });

  test("skips the write entirely when nothing changed", async () => {
    const file = tempFile();
    const write = createIncrementalJSONLWriter(file);
    const a = { id: 1 };
    await write([a]);
    const before = fs.statSync(file).mtimeMs;
    await write([a]);
    expect(fs.readFileSync(file, "utf8")).toBe(fullSnapshot([a]));
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  test("wide characters keep byte offsets accurate", async () => {
    const file = tempFile();
    const write = createIncrementalJSONLWriter(file);
    const a = { text: "héllo 😀 wörld" };
    await write([a]);
    const b = { text: "plain" };
    await write([a, b]);
    expect(fs.readFileSync(file, "utf8")).toBe(fullSnapshot([a, b]));
  });
});
