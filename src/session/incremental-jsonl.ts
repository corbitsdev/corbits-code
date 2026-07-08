import fs from "node:fs";

type WriterState = {
  // Records already on disk, held by reference to detect history rewrites.
  refs: readonly unknown[];
  // Byte offset where each record's line starts; offsets[refs.length] is the
  // file length.
  offsets: number[];
  // Serialized form of the final record, re-checked on every write because the
  // caller may mutate the newest record in place between writes.
  lastLine: string;
};

function lineFor(record: unknown): string {
  return JSON.stringify(record) + "\n";
}

// Append-oriented writer for a JSONL snapshot file that is rewritten with the
// full record history on every checkpoint. Serializing the whole history each
// time is O(session length) per turn and stalls the single-process TUI; this
// writer serializes only records past the longest unchanged prefix (matched by
// reference) and truncates back to that point. A history rewrite such as
// compaction replaces the record objects, fails the reference match, and falls
// back to rewriting from the first changed record.
export function createIncrementalJSONLWriter(
  filePath: string,
): (records: readonly unknown[]) => Promise<void> {
  let state: WriterState | null = null;

  return async (records) => {
    let prefix = 0;
    if (state !== null) {
      const max = Math.min(state.refs.length, records.length);
      while (prefix < max && state.refs[prefix] === records[prefix]) prefix++;
      if (prefix === state.refs.length && prefix > 0 && lineFor(records[prefix - 1]) !== state.lastLine) {
        prefix -= 1;
      }
    }

    const keptOffsets = state === null ? [0] : state.offsets.slice(0, prefix + 1);
    const keepBytes = keptOffsets[prefix]!;
    let text = "";
    const offsets = keptOffsets;
    for (let i = prefix; i < records.length; i++) {
      const line = lineFor(records[i]);
      text += line;
      offsets.push(offsets[i]! + Buffer.byteLength(line));
    }

    const unchanged = state !== null && prefix === state.refs.length && records.length === prefix;
    if (!unchanged) {
      if (state !== null && prefix === state.refs.length) {
        await fs.promises.appendFile(filePath, text);
      } else {
        const handle = await fs.promises.open(filePath, state === null ? "w" : "r+");
        try {
          await handle.truncate(keepBytes);
          if (text.length > 0) await handle.write(text, keepBytes);
        } finally {
          await handle.close();
        }
      }
    }

    state = {
      refs: [...records],
      offsets,
      lastLine: records.length > 0 ? lineFor(records[records.length - 1]) : "",
    };
  };
}
