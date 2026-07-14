import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ToolPlugin } from "@intx/tools-posix";
import { formatReadFileTimeoutMessage } from "./tool-time-budget.js";

// Intercode-side guard for read_file. Stock @intx/tools-posix read-file loads the
// whole file into memory (buffer -> string -> split) and, with no limit, returns
// every line -- so a model told to "go deep" into a tree of large transcripts can
// pull multi-MB files into context with no ceiling and OOM the host. This
// middleware short-circuits read_file with an opencode-style streaming reader that
// never buffers the whole file and caps output. We do not patch interchange.

export const READ_FILE_MAX_BYTES = 50 * 1024;
export const READ_FILE_DEFAULT_MAX_LINES = 2000;
export const READ_FILE_MAX_LINE_LENGTH = 2000;
// Absolute ceiling on bytes scanned from disk, so a deep offset into a huge file
// stays time-bounded even though memory is already bounded by the streaming read.
export const READ_FILE_MAX_SCAN_BYTES = 8 * 1024 * 1024;
// Headroom reserved out of the byte budget for the continuation notice, so the
// returned payload including the notice stays under READ_FILE_MAX_BYTES.
const NOTICE_RESERVE_BYTES = 256;

const TOOL_OUTPUT_URI_PREFIX = "tool-output:";
const LINE_TRUNC_SUFFIX = ` ... [line truncated at ${READ_FILE_MAX_LINE_LENGTH} chars]`;

type TruncReason = "lines" | "bytes" | "scan";

type BoundedRead = { content: string; isError?: boolean };

function numArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberLine(lineNo: number, text: string): string {
  return `${String(lineNo).padStart(6, " ")}\t${text}`;
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
  return new Promise<BoundedRead>((resolveP, rejectP) => {
    const stream = createReadStream(absolutePath);
    const decoder = new StringDecoder("utf8");
    // Budget for emitted lines; the notice is appended out of the reserved slack.
    const contentBudget = READ_FILE_MAX_BYTES - NOTICE_RESERVE_BYTES;

    let pending = "";
    let pendingOverflow = false;
    let firstChunk = true;
    let lineNo = 0;
    let scanned = 0;
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
      rejectP(
        new Error(formatReadFileTimeoutMessage(absolutePath, partial)),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const done = (result: BoundedRead) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      signal.removeEventListener("abort", onAbort);
      resolveP(result);
    };

    // Returns false when no further lines should be processed. `offset` is a
    // zero-based skip count, matching the stock read_file schema.
    const handleLine = (raw: string, overflow: boolean): boolean => {
      lineNo++;
      if (lineNo <= offset) return true;
      if (emitted >= limit) {
        truncReason = "lines";
        return false;
      }
      const tooLong = overflow || raw.length > READ_FILE_MAX_LINE_LENGTH;
      const text = tooLong
        ? raw.slice(0, READ_FILE_MAX_LINE_LENGTH) + LINE_TRUNC_SUFFIX
        : raw;
      const numbered = numberLine(lineNo, text);
      // +1 accounts for the "\n" separator this line adds when joined.
      const bytes = Buffer.byteLength(numbered, "utf8") + 1;
      if (emitted > 0 && outBytes + bytes > contentBudget) {
        truncReason = "bytes";
        return false;
      }
      out.push(numbered);
      outBytes += bytes;
      emitted++;
      lastEmittedLine = lineNo;
      // Truncation is decided by the pre-push check on the NEXT line, so a file
      // that ends exactly at the budget reaches "end" and reports no false
      // continuation notice.
      return true;
    };

    const drainPending = (): boolean => {
      for (;;) {
        const nl = pending.indexOf("\n");
        if (nl === -1) {
          if (pending.length > READ_FILE_MAX_LINE_LENGTH) {
            pending = pending.slice(0, READ_FILE_MAX_LINE_LENGTH);
            pendingOverflow = true;
          }
          return true;
        }
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        const overflow = pendingOverflow;
        pendingOverflow = false;
        if (!handleLine(line, overflow)) return false;
      }
    };

    const finishOk = () => {
      if (emitted === 0) {
        if (lineNo === 0 && endReached) {
          // Genuinely empty file.
          done({ content: "" });
          return;
        }
        // No line reached the requested offset. Only claim EOF when the stream
        // actually ended; otherwise the scan ceiling stopped us short of it and
        // lineNo is not the true file length.
        if (endReached) {
          done({
            content: `[offset ${offset} is beyond end of file (${lineNo} lines)]`,
            isError: true,
          });
        } else {
          done({
            content: `[reached the ${
              READ_FILE_MAX_SCAN_BYTES / (1024 * 1024)
            }MB scan limit before offset ${offset}; the file is larger than read_file scans in one pass. Use a smaller offset or grep to locate content.]`,
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
      // Sample only the first chunk for NUL bytes: a control byte appearing deep
      // in an otherwise-valid file must not discard already-streamed content.
      if (firstChunk) {
        firstChunk = false;
        if (chunk.includes(0)) {
          done({ content: `refusing to read binary file: ${absolutePath}`, isError: true });
          return;
        }
      }
      scanned += chunk.length;
      pending += decoder.write(chunk);
      if (!drainPending()) {
        finishOk();
        return;
      }
      if (scanned >= READ_FILE_MAX_SCAN_BYTES) {
        // Flush the partial line still in `pending` before stopping, so a
        // newline-less giant file is not reported as empty content. Keep a
        // byte/line reason if the flushed line set one; otherwise it is the scan.
        if (pending.length > 0) handleLine(pending, pendingOverflow);
        if (truncReason === undefined) truncReason = "scan";
        finishOk();
      }
    });

    stream.on("end", () => {
      if (settled) return;
      endReached = true;
      pending += decoder.end();
      if (pending.length > 0) handleLine(pending, pendingOverflow);
      finishOk();
    });

    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (err.code === "ENOENT") rejectP(new Error(`file not found: ${absolutePath}`));
      else if (err.code === "EACCES") rejectP(new Error(`permission denied: ${absolutePath}`));
      else if (err.code === "EISDIR") rejectP(new Error(`path is a directory: ${absolutePath}`));
      else rejectP(err);
    });
  });
}

function continuationNotice(
  reason: TruncReason,
  firstLine: number,
  lastLine: number,
  limit: number,
): string {
  // Resume by skipping `lastLine` (zero-based) lines so the next read starts at
  // lastLine + 1.
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

/**
 * Short-circuits read_file for real filesystem paths with a streaming, byte- and
 * line-capped read. tool-output URIs pass through to the stock blob-backed handler.
 * Does not modify interchange.
 */
export function readFileGuardPlugin(cwd: string): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      if (call.name !== "read_file") return next(call, signal);

      const rawPath = call.arguments.path;
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return next(call, signal);
      }
      if (rawPath.startsWith(TOOL_OUTPUT_URI_PREFIX)) {
        return next(call, signal);
      }

      const offsetArg = numArg(call.arguments.offset);
      const limitArg = numArg(call.arguments.limit);
      // `offset` is a zero-based skip count, matching the stock read_file schema.
      const offset = offsetArg !== undefined && offsetArg > 0 ? Math.floor(offsetArg) : 0;
      const limit =
        limitArg !== undefined && limitArg > 0
          ? Math.floor(limitArg)
          : READ_FILE_DEFAULT_MAX_LINES;

      const absolutePath = resolve(cwd, rawPath);

      // Delegate to the stock handler when stat fails or the path is a directory,
      // so ENOENT/EACCES/EISDIR messages stay consistent with the base tool.
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
