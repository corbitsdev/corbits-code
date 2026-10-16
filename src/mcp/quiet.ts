export function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    err.name === "AbortError"
  );
}

export async function closeQuietly(
  close: () => Promise<unknown>,
): Promise<void> {
  try {
    await close();
  } catch {
    return undefined;
  }
}
