export function parsePresentViewFromArgs(rawArgs: string): unknown {
  try {
    return (JSON.parse(rawArgs) as { view?: unknown }).view;
  } catch {
    return undefined;
  }
}