import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findImagePathMentions,
  imageMimeTypeForPath,
  capImageForIngestion,
  imageAttachmentFromPath,
  MAX_IMAGE_DIMENSION,
  userRowText,
} from "./image-attachments.js";

// Minimal from-scratch PNG encoder for test fixtures only. Filling scanlines
// with random RGB bytes keeps them incompressible so the encoded file size
// stays close to a real oversized screenshot, without pulling in an image
// dependency just to build test data.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

function buildTestPng(width: number, height: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // bit depth
  ihdrData.writeUInt8(2, 9); // color type: RGB
  ihdrData.writeUInt8(0, 10);
  ihdrData.writeUInt8(0, 11);
  ihdrData.writeUInt8(0, 12);

  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter: none
    for (let i = rowStart + 1; i < rowStart + 1 + width * 3; i++) {
      raw[i] = Math.floor(Math.random() * 256);
    }
  }

  const idatData = deflateSync(raw);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdrData),
    pngChunk("IDAT", idatData),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("image attachment helpers", () => {
  test("detects supported image MIME types from paths", () => {
    expect(imageMimeTypeForPath("shot.png")).toBe("image/png");
    expect(imageMimeTypeForPath("photo.JPEG")).toBe("image/jpeg");
    expect(imageMimeTypeForPath("animation.gif")).toBe("image/gif");
    expect(imageMimeTypeForPath("notes.txt")).toBeUndefined();
  });

  test("finds image paths embedded in instructions", () => {
    expect(
      findImagePathMentions("what is in /tmp/Screenshot 2026-01-01.png please", "/repo"),
    ).toEqual([{ raw: "/tmp/Screenshot 2026-01-01.png", path: "/tmp/Screenshot 2026-01-01.png" }]);
    expect(findImagePathMentions("look at file:///tmp/my%20shot.png", "/repo")).toEqual([
      { raw: "file:///tmp/my%20shot.png", path: "/tmp/my shot.png" },
    ]);
  });

  test("leaves small images untouched", async () => {
    const small = buildTestPng(20, 20);
    const result = await capImageForIngestion(small, "image/png");
    expect(result.data).toBe(small);
    expect(result.contentType).toBe("image/png");
  });

  test.skipIf(process.platform !== "darwin")(
    "downscales and recompresses an oversized pasted image",
    async () => {
      // ~1700x1700 random-RGB PNG lands around 8MB uncompressed -- comparable
      // to the multi-MB pasted screenshots that were being resent on every
      // turn (see gtm-workbench forensics sessions 019f4fd9*/019f4fdb*/019f4fdc*).
      const large = buildTestPng(1700, 1700);
      expect(large.byteLength).toBeGreaterThan(1_000_000);

      const result = await capImageForIngestion(large, "image/png");

      expect(result.contentType).toBe("image/jpeg");
      expect(result.data.byteLength).toBeLessThan(large.byteLength);

      const tmpPath = `/tmp/corbits-image-cap-test-${process.pid}-${Date.now()}.jpg`;
      await Bun.write(tmpPath, result.data);
      try {
        const dims = await Bun.$`sips -g pixelWidth -g pixelHeight ${tmpPath}`.text();
        const widthMatch = dims.match(/pixelWidth:\s*(\d+)/);
        const heightMatch = dims.match(/pixelHeight:\s*(\d+)/);
        expect(Number(widthMatch?.[1])).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION);
        expect(Number(heightMatch?.[1])).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION);
      } finally {
        await unlink(tmpPath).catch(() => undefined);
      }
    },
  );

  test("falls back to the original bytes when sips is unavailable", async () => {
    if (process.platform === "darwin") return; // covered by the darwin-only test above
    const large = buildTestPng(1700, 1700);
    const result = await capImageForIngestion(large, "image/png");
    expect(result.data).toBe(large);
    expect(result.contentType).toBe("image/png");
  });

  // The dedupe fix (see shell.ts attachClipboardImage) rests entirely on this:
  // two ingests of identical source bytes must hash identically even though
  // capImageForIngestion re-encodes oversized images through `sips`, whose
  // JPEG output is not byte-stable across runs. Sizing the fixture above
  // DOWNSCALE_THRESHOLD_BYTES (300 KB) exercises that re-encode path -- a
  // small fixture would pass even if the hash were taken after capping.
  test("hashes identical source bytes the same regardless of filename, even through the sips recompression path", async () => {
    const bytes = buildTestPng(1200, 1200);
    expect(bytes.byteLength).toBeGreaterThan(300 * 1024);

    const pathA = join(tmpdir(), `corbits-hash-test-a-${process.pid}-${Date.now()}.png`);
    const pathB = join(tmpdir(), `corbits-hash-test-b-${process.pid}-${Date.now()}.png`);
    await Bun.write(pathA, bytes);
    await Bun.write(pathB, bytes);
    try {
      const resultA = await imageAttachmentFromPath(pathA);
      const resultB = await imageAttachmentFromPath(pathB);
      if (!resultA.ok || !resultB.ok) throw new Error("expected both ingests to succeed");

      expect(resultA.attachment.contentHash).toBe(resultB.attachment.contentHash);
      expect(resultA.attachment.id).not.toBe(resultB.attachment.id);
    } finally {
      await unlink(pathA).catch(() => undefined);
      await unlink(pathB).catch(() => undefined);
    }
  });

  test("userRowText returns the text when there are no attachments", () => {
    expect(userRowText("hello", [])).toBe("hello");
  });

  test("userRowText annotates a message with its attachment summary", () => {
    const attachments = [
      {
        id: "a",
        name: "shot.png",
        contentType: "image/png",
        data: new Uint8Array(),
        contentHash: "h",
      },
    ];
    expect(userRowText("hello", attachments)).toBe("hello\n[1 image attached: shot.png]");
    expect(userRowText("", attachments)).toBe("[1 image attached: shot.png]");
  });
});
