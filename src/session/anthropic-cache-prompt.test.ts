import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ConversationTurn } from "@intx/types/runtime";

import { createAnthropicCachePromptTransform } from "./anthropic-cache-prompt.js";
import { createOptimizedContextStore } from "./optimized-context-store.js";

const MINUTE_MS = 60_000;
const NOW = 1_000_000_000_000;
const BODY = "file-body-".repeat(2_000);

const CTX = { state: {} as never, trigger: "test" };

function transformFor(args: {
  protocol: string;
  cacheWriteAt: number | undefined;
  nowMs?: number;
}) {
  return createAnthropicCachePromptTransform({
    nowMs: () => args.nowMs ?? NOW,
    cacheWriteAt: () => args.cacheWriteAt,
    protocol: () => args.protocol,
  });
}

function history(): ConversationTurn[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "read the sources" }],
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "read-1",
          name: "read_file",
          arguments: { path: "src/big.ts" },
        },
      ],
      timestamp: 2,
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          callId: "read-1",
          content: [{ type: "text", text: BODY }],
        },
      ],
      timestamp: 3,
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "bash-1",
          name: "bash",
          arguments: { command: "wc -l src/big.ts" },
        },
      ],
      timestamp: 4,
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          callId: "bash-1",
          content: [{ type: "text", text: BODY }],
        },
      ],
      timestamp: 5,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "newest assistant" }],
      timestamp: 6,
    },
    {
      role: "user",
      content: [{ type: "text", text: "newest user" }],
      timestamp: 7,
    },
  ];
}

describe("anthropic cache prompt transform", () => {
  test("settings off leaves an expired Anthropic prompt unchanged", async () => {
    const turns = history();
    const transform = createAnthropicCachePromptTransform({
      nowMs: () => NOW,
      cacheWriteAt: () => NOW - 6 * MINUTE_MS,
      protocol: () => "anthropic",
      enabled: () => false,
    });
    const result = await transform.apply(turns, CTX);
    expect(result.output).toBe(turns);
    expect(result.record.reason).toBe("disabled");
  });

  test("expired or missing Anthropic stamp stubs old tool bodies and leaves stored turns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anthropic-cache-prompt-"));
    const store = await createOptimizedContextStore(dir);
    const turns = history();
    await store.writeTurns(turns);
    const stored = (await store.load()).turns;
    const diskBefore = await readFile(join(dir, "turns.jsonl"), "utf8");
    const storedJson = JSON.stringify(stored);

    for (const cacheWriteAt of [undefined, NOW - 5 * MINUTE_MS]) {
      const result = await transformFor({
        protocol: "anthropic",
        cacheWriteAt,
      }).apply(stored, CTX);
      expect(JSON.stringify(result.output).length).toBeLessThan(
        storedJson.length,
      );
      expect(result.output).toHaveLength(stored.length);
      expect(JSON.stringify(result.output)).not.toContain(BODY);
      expect(JSON.stringify(result.output)).toContain("newest assistant");
      expect(JSON.stringify(result.output)).toContain("newest user");
      expect(JSON.stringify(result.output)).toContain(
        "[read_file result omitted]",
      );
      expect(JSON.stringify(result.output)).toContain("[bash result omitted]");
      expect(result.record.reason).toBe("stubbed-tool-results");
    }

    expect(JSON.stringify((await store.load()).turns)).toBe(storedJson);
    expect(await readFile(join(dir, "turns.jsonl"), "utf8")).toBe(diskBefore);
    expect(storedJson).toContain(BODY);
  });

  test("a stamp two minutes old returns the same turns", async () => {
    const turns = history();
    const result = await transformFor({
      protocol: "anthropic",
      cacheWriteAt: NOW - 2 * MINUTE_MS,
    }).apply(turns, CTX);
    expect(result.output).toBe(turns);
    expect(result.record.reason).toBe("cache-warm");
  });

  test("openai leaves the prompt unchanged when the stamp is old", async () => {
    const turns = history();
    const result = await transformFor({
      protocol: "openai",
      cacheWriteAt: NOW - 60 * MINUTE_MS,
    }).apply(turns, CTX);
    expect(result.output).toBe(turns);
    expect(result.record.reason).toBe("non-anthropic");
  });
});
