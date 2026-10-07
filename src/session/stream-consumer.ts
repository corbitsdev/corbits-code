import type { ReactorEmittedEvent } from "@intx/inference";
import { getLogger } from "@intx/log";
import { LOG_NAMESPACE_ROOT } from "../branding.js";

// Log stream failures instead of writing to stderr: raw stderr corrupts the TUI frame, especially when several sub-agent streams fail together.
export async function consumeStream(
  stream: AsyncIterable<ReactorEmittedEvent>,
  sink: (event: ReactorEmittedEvent) => void,
): Promise<void> {
  try {
    for await (const event of stream) {
      sink(event);
    }
  } catch (err) {
    getLogger([LOG_NAMESPACE_ROOT, "session", "stream"]).error(
      "agent event stream failed: {error}",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
}
