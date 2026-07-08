import type { ReactorEmittedEvent } from "@intx/inference";
import { getLogger } from "@intx/log";

// Stream failures are logged, not written to stderr: raw stderr writes land in
// the middle of the TUI's frame output and corrupt the screen, which is
// especially visible when several sub-agent streams fail together.
export async function consumeStream(
  stream: AsyncIterable<ReactorEmittedEvent>,
  sink: (event: ReactorEmittedEvent) => void,
): Promise<void> {
  try {
    for await (const event of stream) {
      sink(event);
    }
  } catch (err) {
    getLogger(["intercode", "session", "stream"]).error(
      "agent event stream failed: {error}",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
}
