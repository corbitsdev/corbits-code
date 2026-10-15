import { describe, expect, test } from "bun:test";

import { readClipboardImage } from "./image-attachments.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("readClipboardImage", () => {
  test("turns clipboard image bytes into an attachment without a source path", async () => {
    const result = await readClipboardImage(() =>
      Promise.resolve({
        ok: true,
        mimeType: "image/png",
        bytes: PNG,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment.path).toBeUndefined();
    expect(result.attachment.contentType).toBe("image/png");
    expect(result.attachment.name.startsWith("clipboard-")).toBe(true);
    expect(result.attachment.data.byteLength).toBeGreaterThan(0);
  });

  test("passes a clipboard miss through", async () => {
    const result = await readClipboardImage(() =>
      Promise.resolve({ ok: false, reason: "no image found on the clipboard" }),
    );
    expect(result).toEqual({
      ok: false,
      reason: "no image found on the clipboard",
    });
  });
});
