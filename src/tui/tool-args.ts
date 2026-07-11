// Shared parsing for tool argument payloads the stream reducer consumes.
// Keeps use-stream.ts focused on event ordering and block mutations.

export function parsePresentViewFromArgs(rawArgs: string): unknown {
  try {
    return (JSON.parse(rawArgs) as { view?: unknown }).view;
  } catch {
    return undefined;
  }
}