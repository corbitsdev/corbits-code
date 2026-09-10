import { basename, resolve, isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { MessageAttachment } from "@intx/types/runtime";

export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// A pasted screenshot can be several MB of uncompressed PNG. Attachments land
// verbatim inside a ConversationTurn and are replayed on every subsequent
// inference call until compaction ages them out (src/session/compactor.ts),
// so an oversized image inflates every prompt for as long as the turn
// survives. Downscale/recompress at ingestion time so the worst case is
// bounded regardless of how long that takes.
export const MAX_IMAGE_DIMENSION = 1568;
const DOWNSCALE_THRESHOLD_BYTES = 300 * 1024;
const JPEG_QUALITY = 70;

const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export type PendingImageAttachment = MessageAttachment & {
  id: string;
  path?: string;
  /** Set only for files Corbits created; never the operator's `path`. */
  ephemeralPath?: string;
  /** SHA-256 of the source image file's bytes, used to identify identical images. */
  contentHash: string;
};

/** First existing attachment whose `contentHash` matches the candidate, if any. */
export function findDuplicateAttachment(
  existing: readonly PendingImageAttachment[],
  candidate: PendingImageAttachment,
): PendingImageAttachment | undefined {
  return existing.find(
    (attachment) => attachment.contentHash === candidate.contentHash,
  );
}

export type AttachImageResult =
  | { ok: true; attachment: PendingImageAttachment }
  | { ok: false; reason: string };

export type ClipboardImageResult =
  | { ok: true; attachment: PendingImageAttachment }
  | { ok: false; reason: string };

export function imageMimeTypeForPath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME_BY_EXT[ext];
}

export interface ImagePathMention {
  raw: string;
  path: string;
}

export function findImagePathMentions(
  text: string,
  cwd: string,
): ImagePathMention[] {
  const mentions: ImagePathMention[] = [];
  const seen = new Set<string>();

  const push = (raw: string, path: string | undefined): void => {
    if (path === undefined || seen.has(path)) return;
    seen.add(path);
    mentions.push({ raw, path });
  };

  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    // Keep a lone trailing \r on CRLF out of the scan window.
    const contentEnd =
      lineEnd > lineStart && text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    scanImagePathLine(text, lineStart, contentEnd, cwd, push);
    if (lineEnd === text.length) break;
    lineStart = lineEnd + 1;
  }
  return mentions;
}

const WRAPPERS = new Set(["'", '"', "`"]);
const UNQUOTED_AT =
  /^(?:file:\/\/\S+|(?:[~./]|[A-Za-z]:)[^\n\r]*?\.(?:png|jpe?g|webp|gif)(?=$|\s|[),.;:!?]))/i;

function scanImagePathLine(
  text: string,
  start: number,
  end: number,
  cwd: string,
  push: (raw: string, path: string | undefined) => void,
): void {
  let i = start;
  while (i < end) {
    const ch = text[i];
    if (ch === undefined) break;
    if (WRAPPERS.has(ch)) {
      const close = text.indexOf(ch, i + 1);
      if (close !== -1 && close < end) {
        const raw = text.slice(i, close + 1);
        const inner = text.slice(i + 1, close);
        push(raw, normalizeImagePathCandidate(inner, cwd, true));
        i = close + 1;
        continue;
      }
      // Unmatched opener is not a wrapper; same-line unquoted fallback only.
      i += 1;
      continue;
    }

    if (canStartUnquotedPath(text, i, end)) {
      const match = UNQUOTED_AT.exec(text.slice(i, end));
      if (match?.[0] !== undefined) {
        const raw = trimTrailingPunctuation(match[0]);
        push(raw, normalizeImagePathCandidate(raw, cwd, false));
        i += match[0].length;
        continue;
      }
    }
    i += 1;
  }
}

function canStartUnquotedPath(text: string, i: number, end: number): boolean {
  if (i >= end) return false;
  if (text.startsWith("file://", i)) return true;
  const ch = text[i];
  if (ch === undefined) return false;
  if (ch === "~" || ch === "." || ch === "/") return true;
  if (
    i + 1 < end &&
    ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")) &&
    text[i + 1] === ":"
  ) {
    return true;
  }
  return false;
}

export async function imageAttachmentFromPath(
  path: string,
): Promise<AttachImageResult> {
  const mimeType = imageMimeTypeForPath(path);
  if (mimeType === undefined)
    return { ok: false, reason: "unsupported image type" };
  let info;
  try {
    info = await stat(path);
  } catch {
    return { ok: false, reason: "image file not found" };
  }
  if (!info.isFile()) return { ok: false, reason: "not a file" };
  if (info.size > MAX_IMAGE_ATTACHMENT_BYTES) {
    return {
      ok: false,
      reason: `image is too large; max ${formatBytes(MAX_IMAGE_ATTACHMENT_BYTES)}`,
    };
  }
  const raw = await readFile(path);
  // Hash the source bytes, not the (lossy, non-deterministic) capped output --
  // two ingests of the same clipboard content must hash identically even if
  // downscaling recompresses them differently.
  const contentHash = await hashImageBytes(raw);
  const capped = await capImageForIngestion(raw, mimeType);
  return {
    ok: true,
    attachment: {
      id: crypto.randomUUID(),
      name:
        capped.contentType === mimeType
          ? basename(path)
          : replaceExtension(basename(path), capped.contentType),
      contentType: capped.contentType,
      data: capped.data,
      path,
      contentHash,
    },
  };
}

/** SHA-256 of the source image file's bytes, used to identify identical images regardless of filename or timing. */
async function hashImageBytes(bytes: Buffer): Promise<string> {
  // Buffer's type parameter is the looser ArrayBufferLike (it may back onto a
  // pooled allocation), but readFile never actually hands back a
  // SharedArrayBuffer-backed view, so this is a type-only cast, not a copy.
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Downscale/recompress an image before it enters a turn. Only shells out to
 * `sips` (macOS) when the source exceeds `DOWNSCALE_THRESHOLD_BYTES` --
 * smaller images are typically already screenshot-appropriate and not worth
 * a re-encode. On any failure (non-macOS, sips missing, decode error) the
 * original bytes pass through unchanged so ingestion never breaks on this
 * best-effort step.
 */
export async function capImageForIngestion(
  data: Buffer,
  mimeType: string,
): Promise<{ data: Buffer; contentType: string }> {
  if (data.byteLength <= DOWNSCALE_THRESHOLD_BYTES)
    return { data, contentType: mimeType };
  if (process.platform !== "darwin") return { data, contentType: mimeType };

  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const srcExt =
    mimeType === "image/png"
      ? "png"
      : mimeType === "image/webp"
        ? "webp"
        : mimeType === "image/gif"
          ? "gif"
          : "jpg";
  const srcPath = join(tmpdir(), `corbits-image-cap-src-${stamp}.${srcExt}`);
  const outPath = join(tmpdir(), `corbits-image-cap-out-${stamp}.jpg`);

  try {
    await writeFile(srcPath, data);
    const result = await runProcess("sips", [
      "-Z",
      String(MAX_IMAGE_DIMENSION),
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      String(JPEG_QUALITY),
      srcPath,
      "--out",
      outPath,
    ]);
    if (result.code !== 0) return { data, contentType: mimeType };
    const capped = await readFile(outPath);
    // Only adopt the recompressed version if it actually shrank things --
    // a small/already-compressed source can grow slightly under JPEG
    // re-encoding, and the point of this step is to reduce bytes.
    if (capped.byteLength >= data.byteLength)
      return { data, contentType: mimeType };
    return { data: capped, contentType: "image/jpeg" };
  } catch {
    return { data, contentType: mimeType };
  } finally {
    await unlink(srcPath).catch(() => undefined);
    await unlink(outPath).catch(() => undefined);
  }
}

function replaceExtension(name: string, contentType: string): string {
  const ext =
    contentType === "image/jpeg" ? "jpg" : (contentType.split("/")[1] ?? "jpg");
  const dot = name.lastIndexOf(".");
  return `${dot === -1 ? name : name.slice(0, dot)}.${ext}`;
}

export async function readClipboardImage(): Promise<ClipboardImageResult> {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      reason: "clipboard image paste is currently supported on macOS",
    };
  }

  const tmpPath = `/tmp/corbits-clipboard-${process.pid}-${Date.now()}.png`;
  const script = `
set outPath to POSIX file ${JSON.stringify(tmpPath)}
try
  set pngData to the clipboard as «class PNGf»
  set outFile to open for access outPath with write permission
  set eof of outFile to 0
  write pngData to outFile
  close access outFile
on error errMsg
  try
    close access outPath
  end try
  error errMsg
end try
`;

  const result = await runProcess("osascript", ["-e", script]);
  if (result.code !== 0) {
    await unlink(tmpPath).catch(() => undefined);
    return { ok: false, reason: "no PNG image found on the clipboard" };
  }

  const attachment = await imageAttachmentFromPath(tmpPath);
  await unlink(tmpPath).catch(() => undefined);
  if (!attachment.ok) return attachment;
  const { path: _path, ...clipboardAttachment } = attachment.attachment;
  return {
    ok: true,
    attachment: {
      ...clipboardAttachment,
      name: `clipboard-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
    },
  };
}

export function formatAttachmentSummary(
  attachments: readonly PendingImageAttachment[],
): string {
  if (attachments.length === 0) return "";
  const names = attachments.map((att) => att.name).join(", ");
  return `${attachments.length} image${attachments.length === 1 ? "" : "s"} attached: ${names}`;
}

/** Transcript echo for a user message, annotated with its attachments. */
export function userRowText(
  text: string,
  attachments: readonly PendingImageAttachment[],
): string {
  const summary = formatAttachmentSummary(attachments);
  if (summary.length === 0) return text;
  return text.length === 0 ? `[${summary}]` : `${text}\n[${summary}]`;
}

function normalizeImagePathCandidate(
  input: string,
  cwd: string,
  quoted: boolean,
): string | undefined {
  const resolved = quoted
    ? resolveQuotedImagePath(input)
    : resolveUnquotedImagePath(input);
  if (resolved === undefined) return undefined;
  const expanded =
    resolved === "~" || resolved.startsWith("~/")
      ? resolve(homedir(), resolved.slice(2))
      : resolved;
  if (/\s/.test(expanded) && !isAbsolute(expanded) && !quoted) {
    return undefined;
  }
  const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  return imageMimeTypeForPath(abs) === undefined ? undefined : abs;
}

function resolveQuotedImagePath(inner: string): string | undefined {
  if (inner.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(inner).pathname);
    } catch {
      return undefined;
    }
  }
  return inner;
}

function resolveUnquotedImagePath(input: string): string | undefined {
  const trimmed = trimTrailingPunctuation(input.trim());
  if (trimmed.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(trimmed).pathname);
    } catch {
      return undefined;
    }
  }
  return trimmed.replace(/\\([\\\s'"()])/g, "$1");
}

function trimTrailingPunctuation(input: string): string {
  return input.replace(/[),.;:!?]+$/g, "");
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

async function runProcess(
  command: string,
  args: string[],
): Promise<{ code: number; stderr: string }> {
  return await new Promise((resolveProcess) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const chunks: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (err) =>
      resolveProcess({ code: 1, stderr: err.message }),
    );
    child.on("close", (code) =>
      resolveProcess({
        code: code ?? 1,
        stderr: Buffer.concat(chunks).toString("utf8"),
      }),
    );
  });
}
