import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolPlugin } from "@intx/tools-posix";
import type { BlobReader } from "@intx/types/runtime";
import {
  canonicalToolOutputUri,
  isToolOutputLike,
} from "../util/tool-output-uri.js";
import {
  denyResult,
  errorMessage,
  optionalNumber,
} from "./tool-args.js";
import {
  diagnoseBlockedFileInspection,
  inspectionKindFromFirstChunk,
  PDF_EXTRACTOR_BIN,
} from "./file-inspection-diagnosis.js";

import {
  type BoundedRead,
  READ_FILE_MAX_SCAN_BYTES,
  readBytesBounded,
  readStreamBounded,
} from "../io/bounded-read.js";

export {
  READ_FILE_MAX_BYTES,
  READ_FILE_MAX_LINE_LENGTH,
  READ_FILE_MAX_SCAN_BYTES,
  readBytesBounded,
} from "../io/bounded-read.js";

export const READ_FILE_DEFAULT_MAX_LINES = 2000;
/** Refuse tool-output blobs larger than this before bounded paging. */
export const READ_FILE_MAX_TOOL_OUTPUT_BYTES = READ_FILE_MAX_SCAN_BYTES;

// Corbits Code-side guard for read_file. Stock @intx/tools-posix read-file
// buffers the whole file and returns every line with no cap, so a deep read
// can pull multi-MB files into context and OOM the host.

export interface ReadFileGuardPluginOptions {
  blobReader?: BlobReader;
  /**
   * Resolve the PDF text extractor on PATH. Tests inject a stub; production
   * uses Bun.which("pdftotext").
   */
  whichExtractor?: () => string | null;
  /**
   * Live: whether this session can run host commands (run_shell mounted).
   * Workers flip this after the capability filter; omitted means yes.
   */
  canExecuteHostCommands?: () => boolean;
  /** Model-facing path for the diagnosis text (call argument, not absolute). */
  displayPath?: string;
  /**
   * Test-injectable scan ceiling in bytes. Production leaves this unset and
   * keeps READ_FILE_MAX_SCAN_BYTES, so the ceiling is a constant in shipped
   * code.
   */
  maxScanBytes?: number;
}

function mapFilesystemStreamError(
  displayPath: string,
  err: NodeJS.ErrnoException,
): Error {
  if (err.code === "ENOENT") return new Error(`file not found: ${displayPath}`);
  if (err.code === "EACCES" || err.code === "EPERM") {
    return new Error(
      diagnoseBlockedFileInspection({
        path: displayPath,
        kind: "unreadable",
        extractorAvailable: false,
        canExecuteHostCommands: false,
      }).message,
    );
  }
  if (err.code === "EISDIR")
    return new Error(`path is a directory: ${displayPath}`);
  return err;
}

function isAccessDenied(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

function resolveExtractorProbe(
  whichExtractor: (() => string | null) | undefined,
): boolean {
  const probe = whichExtractor ?? (() => Bun.which(PDF_EXTRACTOR_BIN));
  return probe() !== null;
}

/**
 * Streams a file, emitting up to `limit` line-numbered lines starting at
 * 1-indexed `offset`, holding at most one chunk plus the capped output in
 * memory. Stops at the byte cap, the line cap, or the scan ceiling.
 */
export function readFileBounded(
  absolutePath: string,
  offset: number,
  limit: number,
  signal: AbortSignal,
  inspection?: Pick<
    ReadFileGuardPluginOptions,
    "whichExtractor" | "canExecuteHostCommands" | "displayPath" | "maxScanBytes"
  >,
): Promise<BoundedRead> {
  const labeledPath = inspection?.displayPath ?? absolutePath;
  return readStreamBounded(
    createReadStream(absolutePath),
    absolutePath,
    offset,
    limit,
    signal,
    {
      mapStreamError: (err) => mapFilesystemStreamError(labeledPath, err),
      windowHugeLines: true,
      ...(inspection?.maxScanBytes !== undefined
        ? { maxScanBytes: inspection.maxScanBytes }
        : {}),
      diagnoseFirstChunk: (chunk) => {
        const kind = inspectionKindFromFirstChunk(absolutePath, chunk);
        if (kind === undefined) return undefined;
        return diagnoseBlockedFileInspection({
          path: labeledPath,
          kind,
          extractorAvailable: resolveExtractorProbe(inspection?.whichExtractor),
          canExecuteHostCommands:
            inspection?.canExecuteHostCommands?.() ?? true,
        }).message;
      },
    },
  );
}

function resolveReadFilePaging(
  call: { arguments: Record<string, unknown> },
  defaultLimit = READ_FILE_DEFAULT_MAX_LINES,
): {
  offset: number;
  limit: number;
} {
  const offsetArg = optionalNumber(call.arguments.offset);
  const limitArg = optionalNumber(call.arguments.limit);
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
 * URIs (byte-windowed). Does not modify interchange.
 */
export function readFileGuardPlugin(
  cwd: string,
  options: ReadFileGuardPluginOptions = {},
): ToolPlugin {
  const { blobReader, whichExtractor, canExecuteHostCommands, maxScanBytes } =
    options;
  const inspection = {
    ...(whichExtractor !== undefined ? { whichExtractor } : {}),
    ...(canExecuteHostCommands !== undefined ? { canExecuteHostCommands } : {}),
    ...(maxScanBytes !== undefined ? { maxScanBytes } : {}),
  };
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
          return denyResult(
            call.id,
            `cannot read ${rawPath}: no blob reader is configured for tool-output spills`,
          );
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
            ? denyResult(call.id, res.content)
            : { callId: call.id, content: res.content };
        } catch (err) {
          return denyResult(call.id, errorMessage(err));
        }
      }

      const absolutePath = resolve(cwd, rawPath);

      try {
        const info = await stat(absolutePath);
        if (info.isDirectory()) return next(call, signal);
      } catch (err) {
        if (isAccessDenied(err)) {
          return denyResult(
            call.id,
            diagnoseBlockedFileInspection({
              path: absolutePath,
              kind: "unreadable",
              extractorAvailable: false,
              canExecuteHostCommands: false,
            }).message,
          );
        }
        return next(call, signal);
      }

      try {
        const res = await readFileBounded(absolutePath, offset, limit, signal, {
          ...inspection,
          displayPath: rawPath,
        });
        return res.isError
          ? denyResult(call.id, res.content)
          : { callId: call.id, content: res.content };
      } catch (err) {
        return denyResult(call.id, errorMessage(err));
      }
    },
  };
}
