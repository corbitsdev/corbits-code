import { test, expect } from "bun:test";
import { consumeStream } from "../../src/stream-consumer.js";
import type { ReactorEmittedEvent } from "@intx/inference";

async function* makeStream(events: ReactorEmittedEvent[]): AsyncIterable<ReactorEmittedEvent> {
  for (const event of events) {
    yield event;
  }
}

test("consumeStream calls sink for every event", async () => {
  const events: ReactorEmittedEvent[] = [
    { type: "reactor.start", seq: 1, data: {} as unknown as ReactorEmittedEvent["data"] },
    { type: "inference.tool_call.start", seq: 2, data: { name: "read_file" } as unknown as ReactorEmittedEvent["data"] },
    { type: "tool.done", seq: 3, data: { result: { callId: "c1", content: "ok", isError: false } } as unknown as ReactorEmittedEvent["data"] },
  ];

  const received: ReactorEmittedEvent[] = [];
  await consumeStream(makeStream(events), (event) => received.push(event));

  expect(received.length).toBe(3);
  expect(received[0].type).toBe("reactor.start");
  expect(received[1].type).toBe("inference.tool_call.start");
  expect(received[2].type).toBe("tool.done");
});

test("consumeStream handles empty stream", async () => {
  const received: ReactorEmittedEvent[] = [];
  await consumeStream(makeStream([]), (event) => received.push(event));
  expect(received.length).toBe(0);
});
