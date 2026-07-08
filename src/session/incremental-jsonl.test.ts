import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSegmentedJSONLWriter,
  listSegmentFiles,
  readExtraSegmentTexts,
  segmentFileName,
} from "./incremental-jsonl.js";

const BASE = "turns.jsonl";

function fullSnapshot(records: readonly unknown[]): string {
  if (records.length === 0) return "";
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "seg-jsonl-"));
}

async function combined(dir: string): Promise<string> {
  const names = await listSegmentFiles(dir, BASE);
  return names.map((name) => fs.readFileSync(path.join(dir, name), "utf8")).join("");
}

describe("createSegmentedJSONLWriter", () => {
  test("matches a full rewrite across append-only growth", async () => {
    const dir = tempDir();
    const write = createSegmentedJSONLWriter(dir, BASE, 64);
    const turns: unknown[] = [];
    for (let i = 0; i < 20; i++) {
      turns.push({ role: "user", text: `turn ${i}` });
      await write(turns);
      expect(await combined(dir)).toBe(fullSnapshot(turns));
    }
    const names = await listSegmentFiles(dir, BASE);
    expect(names.length).toBeGreaterThan(1);
  });

  test("rolls to a new segment past the size threshold and seals prior ones", async () => {
    const dir = tempDir();
    const write = createSegmentedJSONLWriter(dir, BASE, 64);
    const turns: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      turns.push({ id: i, filler: "x".repeat(40) });
      await write(turns);
    }
    expect(await pathExists(path.join(dir, segmentFileName(BASE, 1)))).toBe(true);

    const seg0 = path.join(dir, BASE);
    const before = fs.statSync(seg0).mtimeMs;
    const { modifiedPaths } = await write([...turns, { id: 99, filler: "y".repeat(40) }]);
    expect(fs.statSync(seg0).mtimeMs).toBe(before);
    expect(modifiedPaths).not.toContain(BASE);
  });

  test("only the active segment is reported modified on a plain append", async () => {
    const dir = tempDir();
    const write = createSegmentedJSONLWriter(dir, BASE, 64);
    const turns: unknown[] = [{ id: 0, filler: "z".repeat(80) }];
    await write(turns);
    turns.push({ id: 1 });
    const { modifiedPaths } = await write(turns);
    expect(modifiedPaths).toEqual([segmentFileName(BASE, 1)]);
  });

  test("a history rewrite deletes now-stale later segments", async () => {
    const dir = tempDir();
    const write = createSegmentedJSONLWriter(dir, BASE, 64);
    const turns: unknown[] = [];
    for (let i = 0; i < 8; i++) {
      turns.push({ id: i, filler: "q".repeat(40) });
      await write(turns);
    }
    const names = await listSegmentFiles(dir, BASE);
    expect(names.length).toBeGreaterThan(2);

    const compacted = [{ id: "summary" }];
    const { modifiedPaths } = await write(compacted);
    expect(await combined(dir)).toBe(fullSnapshot(compacted));
    expect(await listSegmentFiles(dir, BASE)).toEqual([BASE]);
    for (const name of names.slice(1)) {
      expect(await pathExists(path.join(dir, name))).toBe(false);
      expect(modifiedPaths).toContain(name);
    }
  });

  test("handles a history rewrite that replaces earlier records", async () => {
    const dir = tempDir();
    const write = createSegmentedJSONLWriter(dir, BASE);
    const a = { id: 1 };
    const b = { id: 2 };
    const c = { id: 3 };
    await write([a, b, c]);
    const compacted = [{ id: "summary" }, c];
    await write(compacted);
    expect(await combined(dir)).toBe(fullSnapshot(compacted));
  });

  test("detects in-place mutation of the newest record", async () => {
    const dir = tempDir();
    const write = createSegmentedJSONLWriter(dir, BASE);
    const last: { content: string[] } = { content: ["partial"] };
    await write([{ id: 1 }, last]);
    last.content.push("more");
    await write([{ id: 1 }, last]);
    expect(await combined(dir)).toBe(fullSnapshot([{ id: 1 }, last]));
  });

  test("shrinks the file when records are removed", async () => {
    const dir = tempDir();
    const write = createSegmentedJSONLWriter(dir, BASE);
    const a = { id: 1 };
    const b = { id: 2 };
    await write([a, b]);
    await write([a]);
    expect(await combined(dir)).toBe(fullSnapshot([a]));
  });

  test("writes an empty file for no records", async () => {
    const dir = tempDir();
    const write = createSegmentedJSONLWriter(dir, BASE);
    await write([]);
    expect(fs.readFileSync(path.join(dir, BASE), "utf8")).toBe("");
    await write([{ id: 1 }]);
    expect(await combined(dir)).toBe(fullSnapshot([{ id: 1 }]));
  });

  test("skips the write entirely when nothing changed", async () => {
    const dir = tempDir();
    const write = createSegmentedJSONLWriter(dir, BASE);
    const a = { id: 1 };
    await write([a]);
    const before = fs.statSync(path.join(dir, BASE)).mtimeMs;
    const { modifiedPaths } = await write([a]);
    expect(modifiedPaths).toEqual([]);
    expect(fs.statSync(path.join(dir, BASE)).mtimeMs).toBe(before);
  });

  test("wide characters keep byte offsets accurate across a rollover", async () => {
    const dir = tempDir();
    const write = createSegmentedJSONLWriter(dir, BASE, 48);
    const a = { text: "héllo 😀 wörld" };
    const b = { text: "plain" };
    const c = { text: "trailing 🚀" };
    await write([a]);
    await write([a, b]);
    await write([a, b, c]);
    expect(await combined(dir)).toBe(fullSnapshot([a, b, c]));
  });
});

describe("segment readers", () => {
  test("readExtraSegmentTexts returns tail segments in order", async () => {
    const dir = tempDir();
    const write = createSegmentedJSONLWriter(dir, BASE, 64);
    const turns: unknown[] = [];
    for (let i = 0; i < 8; i++) {
      turns.push({ id: i, filler: "w".repeat(40) });
      await write(turns);
    }
    const names = await listSegmentFiles(dir, BASE);
    const extras = await readExtraSegmentTexts(dir, BASE);
    expect(extras.length).toBe(names.length - 1);
    expect(extras.join("")).toBe(
      names
        .slice(1)
        .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
        .join(""),
    );
  });

  test("a legacy monolithic file reads back as segment zero only", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, BASE), fullSnapshot([{ id: 1 }, { id: 2 }]));
    expect(await listSegmentFiles(dir, BASE)).toEqual([BASE]);
    expect(await readExtraSegmentTexts(dir, BASE)).toEqual([]);
  });
});

async function pathExists(fullPath: string): Promise<boolean> {
  try {
    await fs.promises.access(fullPath);
    return true;
  } catch {
    return false;
  }
}
