import type { BlobReader } from "@intx/types/runtime";

/** Blob reader that resolves the backing store on each read (e.g. after agent rebuild). */
export function createLazyBlobReader(get: () => BlobReader | undefined): BlobReader {
  return {
    read: async (uri: string) => {
      const reader = get();
      if (reader === undefined) {
        throw new Error("blob reader is not configured");
      }
      return reader.read(uri);
    },
  };
}

/**
 * True when a blob read failed because the key is absent (not a bad URI or
 * other hard error). Used so a composite reader can try the next store.
 */
export function isBlobNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes("Blob not found") ||
    msg === "blob reader is not configured"
  );
}

/**
 * Resolve tool-output:// URIs against a primary store, then a fallback
 * (typically child session then parent). Malformed URIs and non-missing
 * failures from the primary are not retried on the fallback.
 */
export function createCompositeBlobReader(
  getPrimary: () => BlobReader | undefined,
  getFallback?: () => BlobReader | undefined,
): BlobReader {
  return {
    read: async (uri: string) => {
      const primary = getPrimary();
      if (primary !== undefined) {
        try {
          return await primary.read(uri);
        } catch (err) {
          if (getFallback === undefined || !isBlobNotFoundError(err)) {
            throw err;
          }
        }
      }

      const fallback = getFallback?.();
      if (fallback === undefined) {
        if (primary === undefined) {
          throw new Error("blob reader is not configured");
        }
        // Primary was configured but missed; re-read so the error message
        // matches a direct miss rather than inventing a composite-only one.
        return primary.read(uri);
      }
      return fallback.read(uri);
    },
  };
}
