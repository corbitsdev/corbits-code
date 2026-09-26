import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ToolPlugin } from "@intx/tools-posix";
import type { BlobReader } from "@intx/types/runtime";
import {
  canonicalToolOutputUri,
  isToolOutputLike,
} from "../util/tool-output-uri.js";
import { formatReadFileTimeoutMessage } from "./tool-time-budget.js";

// Corbits Code-side guard for read_file. Stock @intx/tools-posix read-file loads the
// whole file into memory (buffer -> string -> split) and, with no limit, returns
// every line -- so a model told to "go deep" into a tree of large transcripts can
// pull multi-MB files into context with no ceiling and OOM the host. This
// middleware short-circuits read_file with an opencode-style streaming reader that
// never buffers the whole file and caps output. We do not patch interchange.

export const READ_FILE_MAX_BYTES = 50 * 1024;
export const READ_FILE_DEFAULT_MAX_LINES = 2000;
export const READ_FILE_MAX_LINE_LENGTH = 2000;
// Absolute ceiling on bytes scanned from disk past the requested offset, so an
// emission window stays time-bounded even though memory is already bounded by
// the streaming read. Bytes skipped to reach a nonzero offset do not count:
// continuation past the ceiling must read through to the end, not dead-end
// with a scan limit while unread content remains.
export const READ_FILE_MAX_SCAN_BYTES = 8 * 1024 * 1024;
/** Refuse tool-output blobs larger than this before bounded paging. */
export const READ_FILE_MAX_TOOL_OUTPUT_BYTES = READ_FILE_MAX_SCAN_BYTES;
// Headroom reserved out of the byte budget for the continuation notice, so the
// returned payload including the notice stays under READ_FILE_MAX_BYTES.
const NOTICE_RESERVE_BYTES = 256;

const LINE_TRUNC_SUFFIX = ` ... [line truncated at ${READ_FILE_MAX_LINE_LENGTH} chars; full line remains in the file — use grep to match within the line]`;
const TOOL_OUTPUT_CHUNK_BYTES = 64 * 1024;

type TruncReason = "lines" | "bytes" | "scan";

interface BoundedRead {
  content: string;
  isError?: boolean;
}

export interface ReadFileGuardPluginOptions {
  blobReader?: BlobReader;
}

// A truncated read tells the model to continue with the same path and the
// explicit next offset from the notice ("Use offset=N to continue"). There is
// no continuation handle: every read is a stateless, idempotent ranged read,
// so following a notice verbatim works on first use, on replay, and on a fresh
// plugin instance after compaction or session resume — and re-reading any
// earlier window behaves identically. Chunked same-path reads carry rising
// offsets, so detectors that key on the full call (including arguments) see
// one ranged read per window, not a same-path loop.

function numArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function numberLine(lineNo: number, text: string): string {
  return `${String(lineNo).padStart(6, " ")}\t${text}`;
}

function mapFilesystemStreamError(
  displayPath: string,
  err: NodeJS.ErrnoException,
): Error {
  if (err.code === "ENOENT") return new Error(`file not found: ${displayPath}`);
  if (err.code === "EACCES")
    return new Error(`permission denied: ${displayPath}`);
  if (err.code === "EISDIR")
    return new Error(`path is a directory: ${displayPath}`);
  return err;
}

/**
 * Streams UTF-8 from `stream`, emitting up to `limit` line-numbered lines after
 * skipping `offset` lines (zero-based). Never splits the full decoded text in one pass.
 * When `wrapLongLines` is set, overlong lines are split into successive numbered
 * windows instead of being truncated and dropped — so a giant JSON line can be
 * paged through with the same offset protocol as a multi-line file.
 * When `windowHugeLines` is set instead, only single lines that on their own
 * exceed the output budget are windowed; ordinary lines keep their numbers, so
 * plain path+offset pagination stays line-aligned.
 * The scan ceiling counts only bytes past the requested offset: bytes skipped
 * to reach a nonzero offset never trip it, so continuation on a large file
 * reads through to the end instead of dead-ending with a scan limit while
 * unread content remains.
 */
function readStreamBounded(
  stream: Readable,
  displayPath: string,
  offset: number,
  limit: number,
  signal: AbortSignal,
  options: {
    mapStreamError?: (err: NodeJS.ErrnoException) => Error;
    wrapLongLines?: boolean;
    windowHugeLines?: boolean;
  } = {},
): Promise<BoundedRead> {
  return new Promise<BoundedRead>((resolveP, rejectP) => {
    const {
      mapStreamError,
      wrapLongLines = false,
      windowHugeLines = false,
    } = options;
    const decoder = new StringDecoder("utf8");
    const contentBudget = READ_FILE_MAX_BYTES - NOTICE_RESERVE_BYTES;

    let pending = "";
    let pendingOverflow = false;
    let firstChunk = true;
    let lineNo = 0;
    let scanned = 0;
    let diskBytes = 0;
    let skipDone = offset <= 0;
    let outBytes = 0;
    let emitted = 0;
    let lastEmittedLine = 0;
    let truncReason: TruncReason | undefined;
    let endReached = false;
    let settled = false;
    // Set when the scan ceiling trips: the trailing partial is reported
    // truncated (never windowed), so a line longer than one scan pass keeps
    // the scan-limit notice instead of a byte-limit page.
    let scanCapped = false;

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
          } else if (
            windowHugeLines &&
            pending.length > READ_FILE_MAX_SCAN_BYTES
          ) {
            pending = pending.slice(0, READ_FILE_MAX_LINE_LENGTH);
            pendingOverflow = true;
          }
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
      if (
        !pendingOverflow &&
        !scanCapped &&
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
        // An offset never reached after more than one scan pass of the source
        // is unlocatable in a single pass: report the scan limit, not a
        // beyond-EOF count. Offsets reached within the pass read through even
        // when the skipped prefix alone exceeds the ceiling.
        if (!endReached || diskBytes > READ_FILE_MAX_SCAN_BYTES) {
          done({
            content: `[reached the ${
              READ_FILE_MAX_SCAN_BYTES / (1024 * 1024)
            }MB scan limit before offset ${offset}; the file is larger than read_file scans in one pass. Use a smaller offset or grep to locate content.]`,
            isError: true,
          });
        } else {
          done({
            content: `[offset ${offset} is beyond end of file (${lineNo} lines)]`,
            isError: true,
          });
        }
        return;
      }

      let content = out.join("\n");
      if (truncReason !== undefined) {
        content += `\n\n${continuationNotice(truncReason, offset + 1, lastEmittedLine, limit)}`;
      }
      done({ content });
    };

    stream.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (firstChunk) {
        firstChunk = false;
        if (chunk.includes(0)) {
          done({
            content: `refusing to read binary file: ${displayPath}`,
            isError: true,
          });
          return;
        }
      }
      if (skipDone) scanned += chunk.length;
      diskBytes += chunk.length;
      pending += decoder.write(chunk);
      if (!drainPending()) {
        finishOk();
        return;
      }
      if (scanned >= READ_FILE_MAX_SCAN_BYTES) {
        scanCapped = true;
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
 * Streams a file, emitting up to `limit` line-numbered lines starting at 1-indexed
 * `offset`, and never holding more than one chunk plus the capped output in memory.
 * Stops at the byte cap, the line cap, or the scan ceiling, whichever comes first.
 */
export function readFileBounded(
  absolutePath: string,
  offset: number,
  limit: number,
  signal: AbortSignal,
): Promise<BoundedRead> {
  return readStreamBounded(
    createReadStream(absolutePath),
    absolutePath,
    offset,
    limit,
    signal,
    {
      mapStreamError: (err) => mapFilesystemStreamError(absolutePath, err),
      windowHugeLines: true,
    },
  );
}

/**
 * Bounded read over an in-memory UTF-8 blob (tool-output spills). Feeds the
 * buffer in chunks so offset/limit never require a full-text split. Overlong
 * lines wrap into numbered windows instead of being truncated and dropped, and
 * callers should pass a high `limit` so the byte budget — not the source-file
 * 2000-line cap — pages the spill.
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
    READ_FILE_MAX_SCAN_BYTES / (1024 * 1024)
  }MB scan limit. ${next}]`;
}

function resolveReadFilePaging(
  call: { arguments: Record<string, unknown> },
  defaultLimit = READ_FILE_DEFAULT_MAX_LINES,
): {
  offset: number;
  limit: number;
} {
  const offsetArg = numArg(call.arguments.offset);
  const limitArg = numArg(call.arguments.limit);
  const offset =
    offsetArg !== undefined && offsetArg > 0 ? Math.floor(offsetArg) : 0;
  const limit =
    limitArg !== undefined && limitArg > 0
      ? Math.floor(limitArg)
      : defaultLimit;
  return { offset, limit };
}

/**
 * Short-circuits read_file for filesystem paths (line-capped) and tool-output
 * URIs (byte-windowed, wrapping long lines). Does not modify interchange.
 */
export function readFileGuardPlugin(
  cwd: string,
  options: ReadFileGuardPluginOptions = {},
): ToolPlugin {
  const { blobReader } = options;
  return {
    middleware: (next) => async (call, signal) => {
      if (call.name !== "read_file") return next(call, signal);

      const rawPath = call.arguments.path;
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return next(call, signal);
      }

      const { offset, limit } = resolveReadFilePaging(call);
      const { limit: blobLimit } = resolveReadFilePaging(
        call,
        Number.POSITIVE_INFINITY,
      );

      if (isToolOutputLike(rawPath)) {
        const uri = canonicalToolOutputUri(rawPath);
        if (uri === undefined) {
          return next(call, signal);
        }

        if (blobReader === undefined) {
          return {
            callId: call.id,
            content: `cannot read ${rawPath}: no blob reader is configured for tool-output spills`,
            isError: true,
          };
        }
        try {
          signal.throwIfAborted();
          const bytes = await blobReader.read(uri);
          const res = await readBytesBounded(
            bytes,
            offset,
            blobLimit,
            signal,
            uri,
          );
          return res.isError
            ? { callId: call.id, content: res.content, isError: true }
            : { callId: call.id, content: res.content };
        } catch (err) {
          return {
            callId: call.id,
            content: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }
      }

      const absolutePath = resolve(cwd, rawPath);

      try {
        const info = await stat(absolutePath);
        if (info.isDirectory()) return next(call, signal);
      } catch {
        return next(call, signal);
      }

      try {
        const res = await readFileBounded(absolutePath, offset, limit, signal);
        return res.isError
          ? { callId: call.id, content: res.content, isError: true }
          : { callId: call.id, content: res.content };
      } catch (err) {
        return {
          callId: call.id,
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  };
}
