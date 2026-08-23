import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_SEGMENT_BYTES = 256 * 1024;

interface WriterState {
  // Records already on disk, held by reference to detect history rewrites.
  refs: readonly unknown[];
  // Global byte offset where each record's line starts; offsets[refs.length] is
  // the total byte length across every segment.
  offsets: number[];
  // First record index of each segment, in order. Segment s spans records
  // [segStarts[s], segStarts[s + 1]) and the last segment ends at refs.length.
  segStarts: number[];
  // Serialized form of the final record, re-checked on every write because the
  // caller may mutate the newest record in place between writes.
  lastLine: string;
}

export interface SegmentedWriteResult {
  // Segment files touched (written or deleted) this call, relative to `dir`.
  // The caller stages exactly these so `git add` re-hashes only what changed.
  modifiedPaths: string[];
}

function lineFor(record: unknown): string {
  return JSON.stringify(record) + "\n";
}

async function pathExists(fullPath: string): Promise<boolean> {
  try {
    await fs.promises.access(fullPath);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

/**
 * Filename of segment `index` for an append-only JSONL file. Segment zero keeps
 * the original name (`turns.jsonl`) so legacy monolithic sessions read back as
 * their own first segment; later segments interleave the index before the
 * extension (`turns-0001.jsonl`).
 */
export function segmentFileName(baseName: string, index: number): string {
  if (index === 0) return baseName;
  const dot = baseName.lastIndexOf(".");
  const stem = dot === -1 ? baseName : baseName.slice(0, dot);
  const ext = dot === -1 ? "" : baseName.slice(dot);
  return `${stem}-${String(index).padStart(4, "0")}${ext}`;
}

/**
 * Ordered relative names of the segments that exist on disk for `baseName`,
 * starting at segment zero and stopping at the first gap. Returns an empty list
 * when the base segment is absent.
 */
export async function listSegmentFiles(dir: string, baseName: string): Promise<string[]> {
  if (!(await pathExists(path.join(dir, baseName)))) return [];
  const names = [baseName];
  for (let index = 1; ; index++) {
    const name = segmentFileName(baseName, index);
    if (!(await pathExists(path.join(dir, name)))) break;
    names.push(name);
  }
  return names;
}

/**
 * Highest segment index present on disk for `baseName`, including gapped strays
 * (`turns-0003.jsonl` with `turns-0002.jsonl` missing). Returns -1 when neither
 * the base nor any numbered segment exists. Used by the writer to unlink stale
 * tails after a rewrite when in-memory segment count is unknown.
 */
export async function highestSegmentIndex(dir: string, baseName: string): Promise<number> {
  let highest = -1;
  if (await pathExists(path.join(dir, baseName))) highest = 0;

  const dot = baseName.lastIndexOf(".");
  const stem = dot === -1 ? baseName : baseName.slice(0, dot);
  const ext = dot === -1 ? "" : baseName.slice(dot);
  const numbered = new RegExp(
    `^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)${ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
  );

  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return highest;
    throw cause;
  }
  for (const entry of entries) {
    const match = numbered.exec(entry);
    if (match === null) continue;
    const index = Number(match[1]);
    if (Number.isFinite(index) && index > highest) highest = index;
  }
  return highest;
}

/**
 * Raw text of every segment past the base one (`turns-0001.jsonl`, ...), in
 * order. The base segment is read separately by the underlying store, so this
 * returns only the tail segments the store does not already know about.
 */
export async function readExtraSegmentTexts(dir: string, baseName: string): Promise<string[]> {
  const names = await listSegmentFiles(dir, baseName);
  const texts: string[] = [];
  for (const name of names.slice(1)) {
    texts.push(await fs.promises.readFile(path.join(dir, name), "utf-8"));
  }
  return texts;
}

/**
 * Append-oriented writer for a JSONL snapshot that the caller rebuilds with the
 * full record history on every checkpoint. Serializing the whole history each
 * time is O(session length) per turn and stalls the single-process TUI; equally,
 * re-hashing one ever-growing file on every `git add` is O(session length) per
 * commit. This writer serializes only records past the longest unchanged prefix
 * (matched by reference) and rolls the file into fixed-size segments so sealed
 * segments never change and only the active segment is re-hashed.
 *
 * A history rewrite such as compaction replaces the record objects, fails the
 * reference match, truncates back to the first changed record, and deletes any
 * now-stale later segments. Each write reports the segment files it touched so
 * the caller can stage precisely those.
 *
 * The writer is process-local. Agent rebuilds construct a fresh writer with no
 * in-memory state; the first write after that must still discover and delete
 * stale on-disk segments, or a compaction rewrite leaves orphan tails that the
 * next load concatenates back into history (duplicate tool_call ids).
 */
export function createSegmentedJSONLWriter(
  dir: string,
  baseName: string,
  maxSegmentBytes: number = DEFAULT_MAX_SEGMENT_BYTES,
): (records: readonly unknown[]) => Promise<SegmentedWriteResult> {
  let state: WriterState | null = null;

  return async (records) => {
    let prefix = 0;
    if (state !== null) {
      const max = Math.min(state.refs.length, records.length);
      while (prefix < max && state.refs[prefix] === records[prefix]) prefix++;
      if (
        prefix === state.refs.length &&
        prefix > 0 &&
        lineFor(records[prefix - 1]) !== state.lastLine
      ) {
        prefix -= 1;
      }
    }

    const unchanged = state !== null && prefix === state.refs.length && records.length === prefix;
    if (unchanged) return { modifiedPaths: [] };

    const prevSegStarts = state?.segStarts ?? [0];
    const prevOffsets = state?.offsets ?? [0];
    // Fresh writers have no memory of prior segment count. Discover every
    // on-disk segment (including gapped strays) so a rewrite that produces
    // fewer segments can still unlink the tails a previous writer left behind.
    let prevSegCount = prevSegStarts.length;
    if (state === null) {
      const highest = await highestSegmentIndex(dir, baseName);
      if (highest + 1 > prevSegCount) prevSegCount = highest + 1;
    }

    let firstSeg = 0;
    for (let s = 0; s < prevSegStarts.length; s++) {
      if (prevSegStarts[s]! <= prefix) firstSeg = s;
      else break;
    }

    const firstSegStartRecord = prevSegStarts[firstSeg]!;
    const firstSegEndRecord = prevSegStarts[firstSeg + 1] ?? state?.refs.length ?? 0;
    const prevFirstSegBytes = prevOffsets[firstSegEndRecord]! - prevOffsets[firstSegStartRecord]!;

    const offsets = prevOffsets.slice(0, prefix + 1);
    const keepBytesInFirstSeg = offsets[prefix]! - prevOffsets[firstSegStartRecord]!;

    interface PlanEntry {
      index: number;
      keepBytes: number;
      text: string;
    }
    const plan: PlanEntry[] = [{ index: firstSeg, keepBytes: keepBytesInFirstSeg, text: "" }];
    const newSegStarts = prevSegStarts.slice(0, firstSeg + 1);

    let activeIndex = firstSeg;
    let currentSegBytes = keepBytesInFirstSeg;
    for (let i = prefix; i < records.length; i++) {
      const line = lineFor(records[i]);
      const lineBytes = Buffer.byteLength(line);
      if (currentSegBytes >= maxSegmentBytes) {
        activeIndex += 1;
        currentSegBytes = 0;
        plan.push({ index: activeIndex, keepBytes: 0, text: "" });
        newSegStarts.push(i);
      }
      plan[plan.length - 1]!.text += line;
      currentSegBytes += lineBytes;
      offsets.push(offsets[i]! + lineBytes);
    }

    const modifiedPaths: string[] = [];
    for (const entry of plan) {
      const isFirst = entry.index === firstSeg;
      const existingBytes = isFirst ? prevFirstSegBytes : 0;
      const untouched =
        isFirst && entry.text === "" && entry.keepBytes === existingBytes && state !== null;
      if (untouched) continue;

      const name = segmentFileName(baseName, entry.index);
      const full = path.join(dir, name);
      const truncateInPlace = isFirst && state !== null && entry.keepBytes > 0;
      if (truncateInPlace) {
        // Stale keepBytes (e.g. after external shrink/compaction) can exceed the
        // on-disk size. POSIX truncate-past-EOF pads with null bytes, which
        // poisons the JSONL and breaks resume with `\u0000` parse errors.
        // Never extend via truncate — rewrite the full segment instead.
        let existingSize = 0;
        try {
          existingSize = (await fs.promises.stat(full)).size;
        } catch {
          existingSize = 0;
        }
        if (entry.keepBytes > existingSize) {
          // Offsets are wrong relative to disk. Rebuild the kept prefix from
          // the in-memory records that belong in this segment, then append
          // the planned text (the post-prefix lines for this segment).
          const keptRecords = records.slice(firstSegStartRecord, prefix);
          const fullText = keptRecords.map((r) => lineFor(r)).join("") + entry.text;
          await fs.promises.writeFile(full, fullText);
        } else {
          const handle = await fs.promises.open(full, "r+");
          try {
            await handle.truncate(entry.keepBytes);
            if (entry.text.length > 0) await handle.write(entry.text, entry.keepBytes);
          } finally {
            await handle.close();
          }
        }
      } else {
        await fs.promises.writeFile(full, entry.text);
      }
      modifiedPaths.push(name);
    }

    for (let s = activeIndex + 1; s < prevSegCount; s++) {
      const name = segmentFileName(baseName, s);
      const full = path.join(dir, name);
      if (await pathExists(full)) {
        await fs.promises.unlink(full);
        modifiedPaths.push(name);
      }
    }

    state = {
      refs: [...records],
      offsets,
      segStarts: newSegStarts,
      lastLine: records.length > 0 ? lineFor(records[records.length - 1]) : "",
    };
    return { modifiedPaths };
  };
}
