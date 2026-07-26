import { describe, expect, test } from "bun:test";
import type { ConversationTurn } from "@intx/types/runtime";
import { ageImageBlocks, rehydrateAttachmentImages } from "./attachment-store.js";
import {
  attachmentUri,
  formatAgedImageMarker,
  parseAgedImageMarker,
} from "./attachment-uri.js";

const PNG_B64 = "iVBORw0KGgo=";

describe("attachment URI markers", () => {
  test("round-trips parse of an aged image marker", () => {
    const uri = attachmentUri("img-abc");
    const text = formatAgedImageMarker({ uri, mimeType: "image/png" });
    const parsed = parseAgedImageMarker(text);
    expect(parsed).toEqual({ uri, id: "img-abc", mimeType: "image/png" });
  });
});

describe("ageImageBlocks / rehydrateAttachmentImages", () => {
  test("spills base64 and leaves a rehydratable marker", async () => {
    const turn: ConversationTurn = {
      role: "user",
      content: [
        { type: "text", text: "see this" },
        {
          type: "image",
          source: { kind: "base64", mimeType: "image/png", data: PNG_B64 },
        },
      ],
      timestamp: 1,
    };
    const aged = await ageImageBlocks(turn);
    expect(JSON.stringify(aged.turn)).not.toContain(PNG_B64);
    expect(aged.blobs).toHaveLength(1);
    expect(aged.blobs[0]!.contentType).toBe("image/png");
    expect(new TextDecoder().decode(aged.blobs[0]!.bytes)).toBe(PNG_B64);

    const markerText = aged.turn.content.find((b) => b.type === "text" && b.text.includes("attachment:///"));
    expect(markerText?.type).toBe("text");

    const blobMap = new Map(aged.blobs.map((b) => [b.key, b.bytes]));
    const rehydrated = await rehydrateAttachmentImages([aged.turn], async (key) => {
      const bytes = blobMap.get(key);
      if (bytes === undefined) throw new Error(`Blob not found for key: ${key}`);
      return bytes;
    });
    const image = rehydrated[0]!.content.find((b) => b.type === "image");
    expect(image).toEqual({
      type: "image",
      source: { kind: "base64", mimeType: "image/png", data: PNG_B64 },
    });
  });
});
