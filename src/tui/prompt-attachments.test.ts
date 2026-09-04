import { describe, expect, test } from "bun:test";

import type { AttachImageResult, PendingImageAttachment } from "./image-attachments.js";
import {
  ingestOperatorPrompt,
  ingestPathMentions,
  spliceMentionCompletion,
} from "./prompt-attachments.js";

function attachment(name: string): PendingImageAttachment {
  return {
    id: name,
    name,
    contentType: "image/png",
    data: new Uint8Array([1, 2, 3]),
    contentHash: `hash-${name}`,
  };
}

describe("ingestPathMentions", () => {
  test("leaves text untouched when there is no image path", async () => {
    const result = await ingestPathMentions("just words", "/repo", async () => {
      throw new Error("must not load");
    });
    expect(result.text).toBe("just words");
    expect(result.attachments).toEqual([]);
  });

  test("replaces a loaded path with a marker and returns the attachment", async () => {
    const load = async (path: string): Promise<AttachImageResult> => ({
      ok: true,
      attachment: { ...attachment("shot.png"), path },
    });
    const result = await ingestPathMentions("look at ./shot.png please", "/repo", load);
    expect(result.text).toBe("look at [Attached image: shot.png] please");
    expect(result.attachments).toHaveLength(1);
  });

  test("keeps the raw path when loading fails", async () => {
    const load = async (): Promise<AttachImageResult> => ({ ok: false, reason: "nope" });
    const result = await ingestPathMentions("./shot.png", "/repo", load);
    expect(result.text).toBe("./shot.png");
    expect(result.attachments).toEqual([]);
  });

  test("two mentions of the same bytes keep one attachment and rewrite both tokens to its name", async () => {
    const load = async (path: string): Promise<AttachImageResult> => ({
      ok: true,
      attachment: {
        id: path,
        name: path.endsWith("alias.png") ? "alias.png" : "shot.png",
        contentType: "image/png",
        data: new Uint8Array([1, 2, 3]),
        path,
        contentHash: "same-bytes",
      },
    });
    const result = await ingestPathMentions("see ./shot.png and ./alias.png", "/repo", load);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.name).toBe("shot.png");
    expect(result.text).toBe("see [Attached image: shot.png] and [Attached image: shot.png]");
  });
});

describe("ingestOperatorPrompt", () => {
  test("merges pending attachments and expands a missing @mention", async () => {
    const pending = attachment("clip.png");
    const result = await ingestOperatorPrompt(
      "use @missing.ts",
      "/repo",
      async () => {
        throw new Error("must not load");
      },
      [pending],
    );
    expect(result.text).toContain("@missing.ts (not found)");
    expect(result.attachments).toEqual([pending]);
  });

  test("does not send — only returns ingested text and attachments", async () => {
    const result = await ingestOperatorPrompt("just words", "/repo", async () => {
      throw new Error("must not load");
    });
    expect(result.text).toBe("just words");
    expect(result.attachments).toEqual([]);
  });

  test("a path mention matching a pending clipboard hash keeps the pending attachment", async () => {
    const pending = attachment("clipboard.png");
    const pendingHash = pending.contentHash;
    const load = async (path: string): Promise<AttachImageResult> => ({
      ok: true,
      attachment: { ...attachment("shot.png"), path, contentHash: pendingHash },
    });
    const result = await ingestOperatorPrompt("see ./shot.png", "/repo", load, [pending]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toEqual(pending);
    expect(result.text).toBe("see [Attached image: clipboard.png]");
  });
});

describe("spliceMentionCompletion", () => {
  test("replaces the typed token and keeps the trailing text", () => {
    const value = "read @src/tu rest";
    const spliced = spliceMentionCompletion(value, 5, 12, "src/tui/");
    expect(spliced.value).toBe("read @src/tui/ rest");
    expect(spliced.cursor).toBe(14);
  });

  test("completes a bare @ at the end of the prompt", () => {
    const spliced = spliceMentionCompletion("look @", 5, 6, "AGENTS.md");
    expect(spliced.value).toBe("look @AGENTS.md");
    expect(spliced.cursor).toBe(15);
  });
});
