import { basename, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { readFile, stat, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { MessageAttachment } from "@intx/types/runtime";

export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

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
};

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

export function extractPastedImagePaths(text: string, cwd: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const candidates = lines.length > 1 ? lines : [trimmed];
  const out: string[] = [];
  for (const candidate of candidates) {
    const abs = normalizeImagePathCandidate(candidate, cwd);
    if (abs === undefined) return [];
    out.push(abs);
  }
  return out;
}

export type ImagePathMention = {
  raw: string;
  path: string;
};

export function findImagePathMentions(text: string, cwd: string): ImagePathMention[] {
  const mentions: ImagePathMention[] = [];
  const seen = new Set<string>();
  const pattern = /file:\/\/\S+|(?:[~./]|[A-Za-z]:)[^\n\r]*?\.(?:png|jpe?g|webp|gif)(?=$|\s|[),.;:!?])/gi;
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
    return { ok: false, reason: `image is too large; max ${formatBytes(MAX_IMAGE_ATTACHMENT_BYTES)}` };
  }
  const data = await readFile(path);
  return {
    ok: true,
    attachment: {
      id: crypto.randomUUID(),
      name: basename(path),
      contentType: mimeType,
      data,
      path,
    },
  };
}

export async function readClipboardImage(): Promise<ClipboardImageResult> {
  if (process.platform !== "darwin") {
    return { ok: false, reason: "clipboard image paste is currently supported on macOS" };
  }

  const tmpPath = `/tmp/intercode-clipboard-${process.pid}-${Date.now()}.png`;
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
  const expanded = unquoted === "~" || unquoted.startsWith("~/")
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
  if ((input.startsWith("'") && input.endsWith("'")) || (input.startsWith('"') && input.endsWith('"'))) {
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

async function runProcess(command: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return await new Promise((resolveProcess) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const chunks: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (err) => resolveProcess({ code: 1, stderr: err.message }));
    child.on("close", (code) => resolveProcess({ code: code ?? 1, stderr: Buffer.concat(chunks).toString("utf8") }));
  });
}
