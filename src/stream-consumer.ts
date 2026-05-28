import type { ReactorEmittedEvent } from "@intx/inference";

export async function consumeStream(
  stream: AsyncIterable<ReactorEmittedEvent>,
  sink: (event: ReactorEmittedEvent) => void,
): Promise<void> {
  try {
    for await (const event of stream) {
      sink(event);
    }
  } catch (err) {
    process.stderr.write(
      `[stream-error] ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
