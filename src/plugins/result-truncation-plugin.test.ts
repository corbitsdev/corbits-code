import { describe, expect, test } from "bun:test";
import { createSizeCapTransform } from "@intx/inference";
import type { StrategyContext, ToolResult } from "@intx/types/runtime";
import { MAX_RESULT_CHARS, truncateToolResultContent } from "./result-truncation-plugin.js";

describe("truncateToolResultContent", () => {
  test("within-cap content passes through unchanged", () => {
    const content = "x".repeat(100);
    expect(truncateToolResultContent(content)).toBe(content);
  });

  test("oversized content gets a marker that never promises retrievable remainder", () => {
    const content = "x".repeat(MAX_RESULT_CHARS + 500);
    const truncated = truncateToolResultContent(content);

    expect(truncated).toContain("[output truncated");
    expect(truncated).toContain("NOT retrievable");
    // The pre-cap discard must never be described as recoverable elsewhere.
    expect(truncated).not.toContain("see the rest");
    expect(truncated).not.toContain("Full output available");
  });

  test("truncation marker survives the size-cap blob spill", async () => {
    // Reproduce the production pipeline for an output over MAX_RESULT_CHARS:
    // truncation runs first (at the tool), size-cap spills the already-cut
    // text to a blob and tells the model the blob holds the full output. The
    // blob's tail must therefore carry the honest "discarded, NOT retrievable"
    // marker so the model does not loop re-running the command.
    const original = "x".repeat(MAX_RESULT_CHARS + 500);
    const truncated = truncateToolResultContent(original);

    const blobs = new Map<string, string>();
    const transform = createSizeCapTransform({
      maxChars: 10_000,
      contextStore: {
        writeBlob: async (key: string, bytes: Uint8Array) => {
          blobs.set(key, new TextDecoder().decode(bytes));
        },
      },
    });

    const result: ToolResult = {
      callId: "call-1",
      content: truncated,
      isError: false,
    };
    const { output } = await transform.apply(
      { call: { id: "call-1", name: "run_shell", arguments: {} }, result },
      {} as StrategyContext,
    );

    const spilled = blobs.get("call-1");
    expect(spilled).toBe(truncated);
    // The blob's tail tells the truth about the pre-spill discard.
    expect(spilled).toContain("NOT retrievable");
    expect(spilled?.endsWith("Use offset/limit or a narrower query.]")).toBe(true);
    // The inline marker's blob promise is now genuine: the blob really does
    // hold everything that still exists.
    expect(output.content).toContain("tool-output:///call-1");
  });
});
