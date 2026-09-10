import { test, expect } from "bun:test";
import { consumeStream } from "../../src/session/stream-consumer.js";
import type { ReactorEmittedEvent } from "@intx/inference";

async function* makeStream(
  events: ReactorEmittedEvent[],
): AsyncIterable<ReactorEmittedEvent> {
  for (const event of events) {
    yield event;
  }
}

test("consumeStream handles empty stream", async () => {
  const received: ReactorEmittedEvent[] = [];
  await consumeStream(makeStream([]), (event) => received.push(event));
  expect(received.length).toBe(0);
});
