import { describe, test, expect } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";
import { consumeStream } from "./stream-consumer.js";

async function* eventsThenError(): AsyncIterable<ReactorEmittedEvent> {
  yield { type: "reactor.done" } as unknown as ReactorEmittedEvent;
  throw new Error("upstream closed");
}

describe("consumeStream", () => {
  test("forwards events to the sink", async () => {
    const seen: ReactorEmittedEvent[] = [];
    async function* one(): AsyncIterable<ReactorEmittedEvent> {
      yield { type: "reactor.done" } as unknown as ReactorEmittedEvent;
    }
    await consumeStream(one(), (e) => seen.push(e));
    expect(seen).toHaveLength(1);
  });

  test("does not write stream failures to stderr, which corrupts the TUI", async () => {
    const original = process.stderr.write.bind(process.stderr);
    let wrote = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      wrote += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      await consumeStream(eventsThenError(), () => {});
    } finally {
      process.stderr.write = original;
    }
    expect(wrote).not.toContain("stream-error");
  });
});
