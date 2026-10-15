import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { formatReadFileTimeoutMessage } from "../plugins/tool-time-budget.js";

// The bounded read engine behind read_file's guard: streams a source in one
// pass, emitting up to `limit` line-numbered lines while never buffering more
// than the byte budget plus one chunk. Filesystem and blob adapters (the
// read-file-guard plugin, archive search) feed it their own stream and error
// mapping; policy like the paging default stays with the caller.

export const READ_FILE_MAX_BYTES = 50 * 1024;
export const READ_FILE_MAX_LINE_LENGTH = 2000;
// Absolute ceiling on bytes scanned from disk past the requested offset, so
// an emission window stays time-bounded. Bytes skipped to reach a nonzero
// offset do not count: continuation past the ceiling must read through to
// the end, not dead-end at the limit.
export const READ_FILE_MAX_SCAN_BYTES = 8 * 1024 * 1024;
// Headroom reserved out of the byte budget for the continuation notice, so
// the payload plus notice stays under READ_FILE_MAX_BYTES.
const NOTICE_RESERVE_BYTES = 256;

const LINE_TRUNC_SUFFIX = ` ... [line truncated at ${READ_FILE_MAX_LINE_LENGTH} chars; full line remains in the file — use grep to match within the line]`;
const TOOL_OUTPUT_CHUNK_BYTES = 64 * 1024;

export type TruncReason = "lines" | "bytes" | "scan";

export interface BoundedRead {
  content: string;
  isError?: boolean;
}

// A truncated read tells the model to continue with the same path and the
// explicit next offset from the notice. There is no continuation handle:
// every read is a stateless, idempotent ranged read, so following a notice
// verbatim works on first use, replay, and a fresh plugin instance after
// compaction or session resume. Chunked reads carry rising offsets, so
// call-keying detectors see one ranged read per window, not a same-path
// loop.

function numberLine(lineNo: number, text: string): string {
  return `${String(lineNo).padStart(6, " ")}\t${text}`;
}

/**
 * Streams UTF-8 from `stream`, emitting up to `limit` line-numbered lines
 * after skipping `offset` lines (zero-based); never decodes the full text in
 * one pass. With `wrapLongLines`, overlong lines split into numbered windows
 * so a giant JSON line pages like a multi-line file. With `windowHugeLines`
 * instead, only lines that alone exceed the output budget are windowed, so
 * plain path+offset pagination stays line-aligned.
 */
export function readStreamBounded(
  stream: Readable,
  displayPath: string,
  offset: number,
  limit: number,
  signal: AbortSignal,
  options: {
    mapStreamError?: (err: NodeJS.ErrnoException) => Error;
    wrapLongLines?: boolean;
    windowHugeLines?: boolean;
    diagnoseFirstChunk?: (chunk: Buffer) => string | undefined;
    maxScanBytes?: number;
  } = {},
): Promise<BoundedRead> {
  return new Promise<BoundedRead>((resolveP, rejectP) => {
    const {
      mapStreamError,
      wrapLongLines = false,
      windowHugeLines = false,
      diagnoseFirstChunk,
      maxScanBytes,
    } = options;
    const scanCeiling = maxScanBytes ?? READ_FILE_MAX_SCAN_BYTES;
    const decoder = new StringDecoder("utf8");
    const contentBudget = READ_FILE_MAX_BYTES - NOTICE_RESERVE_BYTES;

    let pending = "";
    let pendingOverflow = false;
    let firstChunk = true;
    let lineNo = 0;
    let scanned = 0;
    let skipDone = offset <= 0;
    let outBytes = 0;
    let emitted = 0;
    let lastEmittedLine = 0;
    let truncReason: TruncReason | undefined;
    let endReached = false;
    let settled = false;

    const out: string[] = [];

    const onAbort = () => {
      if (settled) return;
      settled = true;
      stream.destroy();
      const partial = out.length > 0 ? out.join("\n") : undefined;
      rejectP(new Error(formatReadFileTimeoutMessage(displayPath, partial)));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    const done = (result: BoundedRead) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      signal.removeEventListener("abort", onAbort);
      resolveP(result);
    };

    const handleLine = (raw: string, overflow: boolean): boolean => {
      lineNo++;
      if (lineNo <= offset) return true;
      skipDone = true;
      if (emitted >= limit) {
        truncReason = "lines";
        return false;
      }
      const tooLong = overflow || raw.length > READ_FILE_MAX_LINE_LENGTH;
      const text = tooLong
        ? raw.slice(0, READ_FILE_MAX_LINE_LENGTH) + LINE_TRUNC_SUFFIX
        : raw;
      const numbered = numberLine(lineNo, text);
      const bytes = Buffer.byteLength(numbered, "utf8") + 1;
      if (emitted > 0 && outBytes + bytes > contentBudget) {
        truncReason = "bytes";
        return false;
      }
      out.push(numbered);
      outBytes += bytes;
      emitted++;
      lastEmittedLine = lineNo;
      return true;
    };

    const emitWrapped = (raw: string, keepTail: boolean): boolean => {
      let rest = raw;
      while (rest.length > READ_FILE_MAX_LINE_LENGTH) {
        if (!handleLine(rest.slice(0, READ_FILE_MAX_LINE_LENGTH), false))
          return false;
        rest = rest.slice(READ_FILE_MAX_LINE_LENGTH);
      }
      if (keepTail) return handleLine(rest, false);
      pending = rest;
      return true;
    };

    const drainPending = (): boolean => {
      for (;;) {
        const nl = pending.indexOf("\n");
        if (nl === -1) {
          if (wrapLongLines) return emitWrapped(pending, false);
          if (pending.length > READ_FILE_MAX_LINE_LENGTH && !windowHugeLines) {
            pending = pending.slice(0, READ_FILE_MAX_LINE_LENGTH);
            pendingOverflow = true;
          }
          // windowHugeLines keeps the full pending: the scan trip ends the
          // stream, and flushRemainder windows the remainder so every scanned
          // byte stays reachable through offset continuation.
          return true;
        }
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (wrapLongLines) {
          if (!emitWrapped(line, true)) return false;
        } else {
          const overflow = pendingOverflow;
          pendingOverflow = false;
          if (!overflow && windowHugeLines && line.length > contentBudget) {
            if (!emitWrapped(line, true)) return false;
          } else if (!handleLine(line, overflow)) return false;
        }
      }
    };

    const flushRemainder = (): void => {
      if (pending.length === 0) return;
      if (wrapLongLines) {
        emitWrapped(pending, true);
        return;
      }
      // Windowed even when scan-capped: every window burns a line number,
      // so the footer's offset resumes at the next window instead of promising
      // continuation that skips the unshown middle of an overlong line.
      if (
        !pendingOverflow &&
        windowHugeLines &&
        pending.length > contentBudget
      ) {
        emitWrapped(pending, true);
        return;
      }
      handleLine(pending, pendingOverflow);
    };

    const finishOk = () => {
      if (emitted === 0) {
        if (lineNo === 0 && endReached) {
          done({ content: "" });
          return;
        }
        // Skip bytes are not scanned, so a dead offset on a file larger than
        // the ceiling still reaches EOF. Report the true range, not a scan
        // limit that would hide a reachable EOF.
        if (endReached) {
          done({
            content: `[offset ${offset} is beyond end of file ${displayPath} (${lineNo} lines); valid offsets 0-${lineNo - 1}]`,
            isError: true,
          });
        } else {
          done({
            content: `[reached the ${
              scanCeiling / (1024 * 1024)
            }MB scan limit before offset ${offset}; the file is larger than read_file scans in one pass. Use a smaller offset or grep to locate content.]`,
            isError: true,
          });
        }
        return;
      }

      let content = out.join("\n");
      if (truncReason !== undefined) {
        content += `\n\n${continuationNotice(truncReason, offset + 1, lastEmittedLine, limit, scanCeiling)}`;
      }
      done({ content });
    };

    stream.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (firstChunk) {
        firstChunk = false;
        const diagnosed = diagnoseFirstChunk?.(chunk);
        if (diagnosed !== undefined) {
          done({
            content: diagnosed,
            isError: true,
          });
          return;
        }
        if (chunk.includes(0)) {
          done({
            content: `refusing to read binary file: ${displayPath}`,
            isError: true,
          });
          return;
        }
      }
      if (skipDone) scanned += chunk.length;
      pending += decoder.write(chunk);
      if (!drainPending()) {
        finishOk();
        return;
      }
      if (scanned >= scanCeiling) {
        flushRemainder();
        if (truncReason === undefined) truncReason = "scan";
        finishOk();
      }
    });

    stream.on("end", () => {
      if (settled) return;
      endReached = true;
      pending += decoder.end();
      flushRemainder();
      finishOk();
    });

    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (mapStreamError !== undefined) rejectP(mapStreamError(err));
      else rejectP(err);
    });
  });
}

/**
 * Bounded read over an in-memory UTF-8 blob (tool-output spills). Feeds the
 * buffer in chunks so offset/limit never require a full-text split; overlong
 * lines wrap into numbered windows instead of being truncated. Callers pass
 * a high `limit` so the byte budget, not the source-file 2000-line cap,
 * pages the spill.
 */
export function readBytesBounded(
  bytes: Uint8Array,
  offset: number,
  limit: number,
  signal: AbortSignal,
  displayPath: string,
): Promise<BoundedRead> {
  async function* byteChunks(): AsyncGenerator<Buffer> {
    for (let i = 0; i < bytes.length; i += TOOL_OUTPUT_CHUNK_BYTES) {
      yield Buffer.from(
        bytes.subarray(i, Math.min(i + TOOL_OUTPUT_CHUNK_BYTES, bytes.length)),
      );
    }
  }
  return readStreamBounded(
    Readable.from(byteChunks()),
    displayPath,
    offset,
    limit,
    signal,
    {
      wrapLongLines: true,
    },
  );
}

function continuationNotice(
  reason: TruncReason,
  firstLine: number,
  lastLine: number,
  limit: number,
  scanCeiling: number,
): string {
  const next = `Use offset=${lastLine} to continue.`;
  if (reason === "lines") {
    return `[Showing lines ${firstLine}-${lastLine}; stopped at the ${limit}-line limit. ${next}]`;
  }
  if (reason === "bytes") {
    return `[Showing lines ${firstLine}-${lastLine}; stopped at the ${
      READ_FILE_MAX_BYTES / 1024
    }KB output limit. ${next}]`;
  }
  return `[Showing lines ${firstLine}-${lastLine}; stopped at the ${
    scanCeiling / (1024 * 1024)
  }MB scan limit. ${next}]`;
}
