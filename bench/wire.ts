// Deterministic Anthropic SSE chunk builders for the inference-driven
// workloads. The public `wire.anthropic` DSL only mints one text delta per
// `textBlock`; benchmarks need fine-grained control over delta count and size
// to exercise the per-token buffering path, so we assemble the frames directly.

import { wire } from "@intx/inference-testing";

const a = wire.anthropic;

// A text response streamed as `count` separate `text_delta` frames, each
// carrying `piece`. Framed by the message/content-block envelope the parser
// expects so it terminates cleanly on `message_stop`.
export function textDeltaChunks(count: number, piece: string): Uint8Array[] {
  const chunks: Uint8Array[] = [
    a.messageStart(),
    a.contentBlockStart({ index: 0, kind: "text", text: "" }),
  ];
  for (let i = 0; i < count; i++) {
    chunks.push(a.contentBlockDelta({ index: 0, kind: "text_delta", text: piece }));
  }
  chunks.push(
    a.contentBlockStop({ index: 0 }),
    a.messageDelta({ stopReason: "end_turn" }),
    a.messageStop(),
  );
  return chunks;
}

// A reasoning response streamed as `count` separate `thinking_delta` frames.
export function thinkingDeltaChunks(count: number, piece: string): Uint8Array[] {
  const chunks: Uint8Array[] = [
    a.messageStart(),
    a.contentBlockStart({ index: 0, kind: "thinking", thinking: "" }),
  ];
  for (let i = 0; i < count; i++) {
    chunks.push(
      a.contentBlockDelta({ index: 0, kind: "thinking_delta", thinking: piece }),
    );
  }
  chunks.push(
    a.contentBlockDelta({ index: 0, kind: "signature_delta", signature: "sig" }),
    a.contentBlockStop({ index: 0 }),
    a.messageDelta({ stopReason: "end_turn" }),
    a.messageStop(),
  );
  return chunks;
}
