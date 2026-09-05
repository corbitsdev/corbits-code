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
  /** SHA-256 of the source image file's bytes, used to dedupe repeat pastes. */
  contentHash: string;
};

export type AttachImageResult =
  { ok: true; attachment: PendingImageAttachment } | { ok: false; reason: string };

export type ClipboardImageResult =
  { ok: true; attachment: PendingImageAttachment } | { ok: false; reason: string };

export function imageMimeTypeForPath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME_BY_EXT[ext];
}

export interface ImagePathMention {
  raw: string;
  path: string;
}

export function findImagePathMentions(text: string, cwd: string): ImagePathMention[] {
  const mentions: ImagePathMention[] = [];
  const seen = new Set<string>();
  const pattern =
    /file:\/\/\S+|(?:[~./]|[A-Za-z]:)[^\n\r]*?\.(?:png|jpe?g|webp|gif)(?=$|\s|[),.;:!?])/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = trimTrailingPunctuation(match[0] ?? "");
    const path = normalizeImagePathCandidate(raw, cwd);
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    mentions.push({ raw, path });
  }
  return mentions;
}

export async function imageAttachmentFromPath(path: string): Promise<AttachImageResult> {
  const mimeType = imageMimeTypeForPath(path);
  if (mimeType === undefined) return { ok: false, reason: "unsupported image type" };
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

/** SHA-256 of the source image file's bytes, used to identify identical pastes regardless of filename or timing. */
async function hashImageBytes(bytes: Buffer): Promise<string> {
  // Buffer's type parameter is the looser ArrayBufferLike (it may back onto a
  // pooled allocation), but readFile never actually hands back a
  // SharedArrayBuffer-backed view, so this is a type-only cast, not a copy.
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
  if (data.byteLength <= DOWNSCALE_THRESHOLD_BYTES) return { data, contentType: mimeType };
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
    if (capped.byteLength >= data.byteLength) return { data, contentType: mimeType };
    return { data: capped, contentType: "image/jpeg" };
  } catch {
    return { data, contentType: mimeType };
  } finally {
    await unlink(srcPath).catch(() => undefined);
    await unlink(outPath).catch(() => undefined);
  }
}

function replaceExtension(name: string, contentType: string): string {
  const ext = contentType === "image/jpeg" ? "jpg" : (contentType.split("/")[1] ?? "jpg");
  const dot = name.lastIndexOf(".");
  return `${dot === -1 ? name : name.slice(0, dot)}.${ext}`;
}

export async function readClipboardImage(): Promise<ClipboardImageResult> {
  if (process.platform !== "darwin") {
    return { ok: false, reason: "clipboard image paste is currently supported on macOS" };
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

export function formatAttachmentSummary(attachments: readonly PendingImageAttachment[]): string {
  if (attachments.length === 0) return "";
  const names = attachments.map((att) => att.name).join(", ");
  return `${attachments.length} image${attachments.length === 1 ? "" : "s"} attached: ${names}`;
}

function normalizeImagePathCandidate(input: string, cwd: string): string | undefined {
  const unquoted = unquoteShellPath(trimTrailingPunctuation(input.trim()));
  if (unquoted === undefined) return undefined;
  const expanded =
    unquoted === "~" || unquoted.startsWith("~/")
      ? resolve(homedir(), unquoted.slice(2))
      : unquoted;
  if (/\s/.test(expanded) && !isAbsolute(expanded) && input[0] !== "'" && input[0] !== '"') {
    return undefined;
  }
  const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  return imageMimeTypeForPath(abs) === undefined ? undefined : abs;
}

function unquoteShellPath(input: string): string | undefined {
  if (input.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(input).pathname);
    } catch {
      return undefined;
    }
  }
  if (
    (input.startsWith("'") && input.endsWith("'")) ||
    (input.startsWith('"') && input.endsWith('"'))
  ) {
    return input.slice(1, -1);
  }
  return input.replace(/\\([\\\s'"()])/g, "$1");
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
    child.on("error", (err) => resolveProcess({ code: 1, stderr: err.message }));
    child.on("close", (code) =>
      resolveProcess({ code: code ?? 1, stderr: Buffer.concat(chunks).toString("utf8") }),
    );
  });
}
