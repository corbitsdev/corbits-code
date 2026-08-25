/**
 * Golden tests: sanitized Responses SSE fixtures → InferenceEvent sequences.
 *
 * Fixtures live under tests/fixtures/codex-sse/ (JSON arrays of SSE data payloads).
 * These pin edge-event handling without live network or real tokens/prompts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createCodexResponsesAdapter,
  isResponsesStreamTerminal,
  tagSignature,
} from "../../src/provider/codex-responses-adapter.js";
import type { InferenceEvent, LastCycleSource } from "@intx/types/runtime";
import { ProtocolMismatchError } from "@intx/inference";

const SOURCE: LastCycleSource = {
  sourceId: "codex/fixture",
  provider: "codex-responses",
  model: "gpt-fixture-codex",
};

const FIXTURE_DIR = join(import.meta.dirname, "../fixtures/codex-sse");

function loadFixture(name: string): object[] {
  const raw = readFileSync(join(FIXTURE_DIR, name), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`fixture ${name}: expected JSON array of SSE payloads`);
  }
  return parsed as object[];
}

/** Parse a full fixture stream with one adapter instance (shared indexer). */
function parseFixture(name: string): InferenceEvent[] {
  const adapter = createCodexResponsesAdapter(SOURCE);
  const out: InferenceEvent[] = [];
  for (const event of loadFixture(name)) {
    out.push(...adapter.parseResponse(JSON.stringify(event)));
  }
  return out;
}

/** Parse until the first throw; return events emitted before the failure. */
function parseUntilError(name: string): { events: InferenceEvent[]; error: unknown } {
  const adapter = createCodexResponsesAdapter(SOURCE);
  const events: InferenceEvent[] = [];
  let error: unknown;
  for (const event of loadFixture(name)) {
    try {
      events.push(...adapter.parseResponse(JSON.stringify(event)));
    } catch (e) {
      error = e;
      break;
    }
  }
  return { events, error };
}

function eventTypes(events: InferenceEvent[]): string[] {
  return events.map((e) => e.type);
}

describe("codex-sse fixtures (golden parse)", () => {
  test("interleaved reasoning + text + tools maps to stable InferenceEvent sequence", () => {
    const out = parseFixture("interleaved-reasoning-text-tools.json");

    // Lifecycle / content_part / *.done envelopes produce nothing; only deltas,
    // tool start, signature, and completed usage.
    expect(eventTypes(out)).toEqual([
      "inference.thinking.delta", // output_item.added reasoning (empty pre-register)
      "inference.thinking.delta", // "consider "
      "inference.thinking.delta", // "options"
      "inference.block.signature",
      "inference.text.delta", // "I will "
      "inference.text.delta", // "check."
      "inference.tool_call.start",
      "inference.tool_call.delta",
      "inference.tool_call.delta",
      "inference.usage",
    ]);

    // Block indices: reasoning=0, text=1, tool=2 (arrival order by item_id).
    expect(out[0]).toMatchObject({
      type: "inference.thinking.delta",
      data: { token: "", index: 0 },
    });
    expect(out[1]).toMatchObject({
      type: "inference.thinking.delta",
      data: { token: "consider ", index: 0 },
    });
    expect(out[2]).toMatchObject({
      type: "inference.thinking.delta",
      data: { token: "options", index: 0 },
    });
    expect(out[3]).toMatchObject({
      type: "inference.block.signature",
      data: { signature: tagSignature(SOURCE.provider, "ENC_FIXTURE_BLOB_NOT_REAL"), index: 0 },
    });
    expect(out[4]).toMatchObject({
      type: "inference.text.delta",
      data: { token: "I will ", index: 1 },
    });
    expect(out[5]).toMatchObject({
      type: "inference.text.delta",
      data: { token: "check.", index: 1 },
    });
    expect(out[6]).toMatchObject({
      type: "inference.tool_call.start",
      data: { callId: "call_fixture_read", name: "read_file", index: 2 },
    });
    // Adapter wire shape: argument deltas use String(blockIndex) as callId
    // (harness maps that placeholder to the real call_id from start).
    expect(out[7]).toMatchObject({
      type: "inference.tool_call.delta",
      data: { callId: "2", argumentFragment: '{"path":', index: 2 },
    });
    expect(out[8]).toMatchObject({
      type: "inference.tool_call.delta",
      data: { argumentFragment: '"src/app.ts"}', index: 2 },
    });
    expect(out[9]).toMatchObject({
      type: "inference.usage",
      data: {
        usage: { input: 104, output: 40, cacheRead: 16, cacheWrite: 0, thinking: 12 },
        source: SOURCE,
      },
    });

    // Terminal event in the fixture is response.completed.
    const lastPayload = loadFixture("interleaved-reasoning-text-tools.json").at(-1)!;
    expect(isResponsesStreamTerminal(JSON.stringify(lastPayload))).toBe(true);
  });

  test("incomplete stream emits partial text and is terminal without usage", () => {
    const out = parseFixture("incomplete.json");

    expect(eventTypes(out)).toEqual(["inference.text.delta", "inference.text.delta"]);
    expect(out[0]).toMatchObject({
      type: "inference.text.delta",
      data: { token: "partial ", index: 0 },
    });
    expect(out[1]).toMatchObject({
      type: "inference.text.delta",
      data: { token: "answer", index: 0 },
    });
    // response.incomplete is intentionally not mapped to usage (completed-only).
    expect(out.some((e) => e.type === "inference.usage")).toBe(false);

    const lastPayload = loadFixture("incomplete.json").at(-1)!;
    expect(isResponsesStreamTerminal(JSON.stringify(lastPayload))).toBe(true);
  });

  test("failed response throws ProtocolMismatchError after prior deltas", () => {
    const { events, error } = parseUntilError("failed.json");

    expect(eventTypes(events)).toEqual(["inference.text.delta"]);
    expect(events[0]).toMatchObject({
      type: "inference.text.delta",
      data: { token: "before fail" },
    });
    expect(error).toBeInstanceOf(ProtocolMismatchError);
    expect(String(error)).toMatch(/fixture backend failure \(sanitized\)/);
  });

  test("stream error event throws ProtocolMismatchError", () => {
    const { events, error } = parseUntilError("error.json");

    expect(events).toHaveLength(0);
    expect(error).toBeInstanceOf(ProtocolMismatchError);
    expect(String(error)).toMatch(/fixture stream error \(sanitized\)/);
  });

  test("lifecycle envelopes alone produce no InferenceEvents", () => {
    const out = parseFixture("lifecycle-ignored.json");
    expect(out).toEqual([]);

    // response.done is a terminal alias even when it yields no payload events.
    const lastPayload = loadFixture("lifecycle-ignored.json").at(-1)!;
    expect((lastPayload as { type: string }).type).toBe("response.done");
    expect(isResponsesStreamTerminal(JSON.stringify(lastPayload))).toBe(true);
  });
});
